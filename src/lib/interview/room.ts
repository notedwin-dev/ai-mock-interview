import { generateStructured, type LlmRoute, type StructuredOptions } from "@/lib/ai/llm";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { UnitConflictError } from "@/lib/interview/unit-conflict";
import { resolveForOutboundCall } from "@/lib/providers/config";
import { InterviewError } from "./service";
import { z } from "zod";

/**
 * Token-scoped live interview turn engine (FR-INTERVIEW-002/003/004; TT-8/11).
 * A link grants exactly one interview's conversation: no account session, no
 * other interviews, no profile data. Each turn persists the candidate message
 * and the interviewer reply chronologically, groups them into assessment
 * units (a new primary question opens a unit; follow-ups join the active one)
 * and is idempotent on the candidate's key.
 */

export interface RoomContext {
  sessionId: string;
  userId: string;
  jobRole: string;
  jobDescription: string | null;
  evaluationMode: string;
  status: string;
}

export interface TranscriptEntry {
  sequenceNumber: number;
  speakerType: string;
  messageKind: string;
  contentText: string;
  assessmentUnitId: string | null;
}

export interface RoomStore {
  context(token: string): Promise<RoomContext | null>;
  messages(sessionId: string): Promise<TranscriptEntry[]>;
  /** Finds an existing candidate message by idempotency key (replay path). */
  findCandidateByKey(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<TranscriptEntry | null>;
  activate(sessionId: string): Promise<"activated" | "already_active" | "rejected">;
  appendCandidate(
    sessionId: string,
    contentText: string,
    idempotencyKey: string | undefined,
    assessmentUnitId: string | null,
  ): Promise<{ entry: TranscriptEntry; created: boolean }>;
  appendInterviewer(
    sessionId: string,
    contentText: string,
    messageKind: string,
    assessmentUnitId: string | null,
  ): Promise<TranscriptEntry>;
  activeUnit(sessionId: string): Promise<string | null>;
  openUnit(sessionId: string, unitNumber: number): Promise<string>;
  closeUnit(unitId: string): Promise<void>;
  complete(sessionId: string): Promise<void>;
  /**
   * Deletes the candidate message identified by (session, idempotency key)
   * when its turn could not be completed (unit conflict). Returns whether a
   * row was removed, so the caller can reject instead of persisting an
   * unanswered candidate message.
   */
  rollbackCandidate(sessionId: string, idempotencyKey: string): Promise<boolean>;
}

export interface RoomTurnInput {
  contentText: string;
  idempotencyKey?: string;
}

export interface RoomTurnResult {
  messages: TranscriptEntry[];
  endCall: boolean;
  created: boolean;
}

export type RoomErrorCode =
  | "invitation_not_found"
  | "invalid_state"
  | "invalid_input"
  | "turn_pending";

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export const roomLlmOutputSchema = z
  .object({
    interviewerText: z.string().trim().min(1).max(2000),
    // Kinds are constrained to the conversation_message CHECK domain
    // (primary_question | follow_up_question | candidate_response |
    // acknowledgement). The interviewer only ever emits the first two; a
    // "transition" kind does not exist in the DB and would violate the
    // constraint after the candidate turn is already persisted.
    messageKind: z.enum(["primary_question", "follow_up_question"]),
    endCall: z.boolean(),
  })
  .strict();
export type RoomLlmOutput = z.infer<typeof roomLlmOutputSchema>;

export interface RoomDeps {
  store?: RoomStore;
  resolveRoute?: (userId: string) => Promise<LlmRoute>;
  generate?: (
    route: LlmRoute,
    options: StructuredOptions<RoomLlmOutput>,
  ) => Promise<RoomLlmOutput>;
}

export const MAX_PRIMARY_QUESTIONS = 6;

/**
 * In-process claim for a (session, idempotency key) turn currently generating.
 * It prevents two concurrent submissions of the same key from both generating
 * and persisting a reply. The loser gets `turn_pending` and retries later (then
 * replaying the finalized turn, or resuming if the owner failed and released the
 * claim). Multi-process deployments need a shared lease instead — noted in the
 * slice report.
 */
const TURN_CLAIM_TTL_MS = 120_000;
const turnClaims = new Map<string, { token: number; startedAt: number }>();
let turnClaimSequence = 0;

function claimTurn(sessionId: string, idempotencyKey: string): number | null {
  const key = `${sessionId}:${idempotencyKey}`;
  const existing = turnClaims.get(key);
  if (existing) {
    if (Date.now() - existing.startedAt < TURN_CLAIM_TTL_MS) return null;
    // A crashed owner's lease expired: take it over and resume.
  }
  const token = ++turnClaimSequence;
  turnClaims.set(key, { token, startedAt: Date.now() });
  return token;
}

function releaseTurnClaim(sessionId: string, idempotencyKey: string, token: number): void {
  const key = `${sessionId}:${idempotencyKey}`;
  if (turnClaims.get(key)?.token === token) turnClaims.delete(key);
}

function roomInstructions(context: RoomContext, primaryCount: number): string {
  return [
    "You are the AIMIS AI interviewer in a live mock interview.",
    `Target role: ${context.jobRole}. Job description: ${context.jobDescription ?? "not supplied"}. Evaluation mode: ${context.evaluationMode}.`,
    "Ask short, focused questions and never invent facts about the candidate.",
    "Use primary_question only for a new assessment area; use follow_up_question to probe the candidate's last answer. When you move to a new area, emit the next primary_question directly — do not emit a separate transition message.",
    primaryCount >= MAX_PRIMARY_QUESTIONS
      ? "The interview is complete: reply with a brief follow_up_question that closes the conversation (for example, thanking the candidate) and set endCall=true."
      : "Set endCall=true only after the interview is genuinely complete. Choose at most one follow-up per answer.",
  ].join(" ");
}

/** Runs one candidate turn and the interviewer's response, atomically in order. */
export async function runRoomTurn(
  token: string,
  input: unknown,
  deps: RoomDeps = {},
): Promise<RoomTurnResult> {
  let parsed: RoomTurnInput;
  try {
    parsed = z
      .object({
        contentText: z.string().trim().min(1).max(5000),
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{1,100}$/)
          .optional(),
      })
      .strict()
      .parse(input);
  } catch (error) {
    throw new RoomError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid interview turn.",
    );
  }

  const store = deps.store ?? createDefaultRoomStore();
  const context = await store.context(token);
  if (!context) throw new RoomError("invitation_not_found", "This interview link is not available.");
  const finalized = context.status !== "scheduled" && context.status !== "active";
  // Finalized contexts replay a valid, non-revoked token's existing turn
  // (idempotent retry after e.g. a network drop at completion time); NEW work
  // is still rejected. The key uniquely identifies the retried turn.
  if (finalized) {
    if (
      parsed.idempotencyKey &&
      (await store.findCandidateByKey(context.sessionId, parsed.idempotencyKey))
    ) {
      return { messages: await store.messages(context.sessionId), endCall: true, created: false };
    }
    throw new RoomError("invalid_state", "This interview is not accepting turns.");
  }

  const existing = parsed.idempotencyKey
    ? await store.findCandidateByKey(context.sessionId, parsed.idempotencyKey)
    : null;

  // Claim this turn before generating. A concurrent request with the same key
  // must wait (retryable pending) instead of producing a duplicate reply.
  const claim = parsed.idempotencyKey
    ? claimTurn(context.sessionId, parsed.idempotencyKey)
    : null;
  if (parsed.idempotencyKey && claim === null) {
    throw new RoomError(
      "turn_pending",
      "Another response for this answer is still being generated. Try again in a moment.",
    );
  }

  try {
    // Atomic admission BEFORE the candidate row is inserted: a concurrent
    // completion must win (no candidate row), and an already-active interview
    // must not have startedAt reset by this retry.
    if (context.status === "scheduled" || context.status === "active") {
      const admitted = await store.activate(context.sessionId);
      if (admitted === "rejected") {
        if (existing) {
          return { messages: await store.messages(context.sessionId), endCall: true, created: false };
        }
        throw new RoomError("invalid_state", "This interview is not accepting turns.");
      }
    }

    const activeUnitId = await store.activeUnit(context.sessionId);
    const candidate = await store
      .appendCandidate(
        context.sessionId,
        parsed.contentText,
        parsed.idempotencyKey,
        activeUnitId,
      )
      .catch((error: unknown) => {
        // The shared append path rejects a candidate row when completion won
        // the race; keep the room's stable invalid_state contract.
        if (error instanceof InterviewError && error.code === "invalid_state") {
          throw new RoomError("invalid_state", error.message);
        }
        throw error;
      });
    if (!candidate.created) {
      // Replay of an already-submitted key. If the interviewer reply for this
      // candidate message already exists, the turn is finalized: return the
      // stored transcript unchanged. Otherwise the previous attempt failed
      // during generation — resume it so no candidate message is dangling.
      const history = await store.messages(context.sessionId);
      const index = history.findIndex((m) => m.sequenceNumber === candidate.entry.sequenceNumber);
      const next = index >= 0 ? history[index + 1] : undefined;
      if (next && next.speakerType === "interviewer") {
        return { messages: history, endCall: false, created: false };
      }
    }

    return await completeTurn(context, {
      store,
      deps,
      parsed,
      activeUnitId,
      created: candidate.created,
    });
  } finally {
    if (parsed.idempotencyKey && claim !== null) {
      releaseTurnClaim(context.sessionId, parsed.idempotencyKey, claim);
    }
  }
}

/**
 * Shared tail of a room turn: builds history, runs the interviewer LLM,
 * opens/closes assessment units, appends the reply and completes the session.
 * On an openUnit conflict the losing turn's candidate message is rolled back
 * so a persisted candidate message is never left without a reply.
 */
async function completeTurn(
  context: RoomContext,
  parts: {
    store: RoomStore;
    deps: RoomDeps;
    parsed: RoomTurnInput;
    activeUnitId: string | null;
    created: boolean;
  },
): Promise<RoomTurnResult> {
  const { store, deps, parsed, activeUnitId, created } = parts;
  const history = await store.messages(context.sessionId);
  const primaryCount = history.filter((message) => message.messageKind === "primary_question").length;
  const route = await (deps.resolveRoute ?? (async (userId: string) => {
    const resolved = await resolveForOutboundCall(userId, "llm");
    return {
      providerName: resolved.providerName,
      providerType: resolved.providerType,
      baseUrl: resolved.baseUrl,
      modelId: resolved.modelId,
      apiKey: resolved.apiKey,
    };
  }))(context.userId);
  const generate = deps.generate ?? generateStructured;
  const output = roomLlmOutputSchema.parse(
    await generate(route, {
      schema: roomLlmOutputSchema,
      instructions: roomInstructions(context, primaryCount),
      prompt: history
        .map((message) => `${message.speakerType}(${message.messageKind}): ${message.contentText}`)
        .join("\n"),
    }),
  );

  let unitId = activeUnitId;
  if (output.messageKind === "primary_question") {
    // A completed interview must not gain a seventh primary question: the
    // sixth question is askable and answerable, and the NEXT primary closes
    // the interview (the completion predicate below mirrors it).
    if (primaryCount >= MAX_PRIMARY_QUESTIONS && !output.endCall) {
      throw new RoomError(
        "invalid_state",
        "The interviewer produced an unexpected follow-up question after the final question.",
      );
    }
    if (unitId) await store.closeUnit(unitId);
    try {
      unitId = await store.openUnit(context.sessionId, primaryCount + 1);
    } catch (error) {
      // Only a unit-number collision is a concurrency conflict. Other failures
      // (connection, timeout, constraint) propagate untouched and must NOT roll
      // the candidate message back — cleanup is specific to the conflict.
      if (!(error instanceof UnitConflictError) || !parsed.idempotencyKey) throw error;
      const rolledBack = await store.rollbackCandidate(context.sessionId, parsed.idempotencyKey);
      if (!rolledBack) throw error;
      throw new RoomError(
        "invalid_state",
        "Another response was processed at the same moment. Send your answer again.",
      );
    }
  }
  await store.appendInterviewer(
    context.sessionId,
    output.interviewerText,
    output.messageKind,
    unitId,
  );

  // The sixth question completes the interview once ANSWERED: when the model
  // asks primary #6 and endCall arrives with that answer's turn, both the
  // reply and the completion land atomically here.
  const endCall = output.endCall || primaryCount + 1 > MAX_PRIMARY_QUESTIONS;
  if (endCall) await store.complete(context.sessionId);
  return { messages: await store.messages(context.sessionId), endCall, created };
}
