import { generateStructured, type StructuredOptions } from "@/lib/ai/llm";
import { assertTtsWireSupported, TtsError } from "@/lib/ai/tts";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { UnitConflictError } from "@/lib/interview/unit-conflict";
import { resolveForOutboundCall } from "@/lib/providers/config";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import { InterviewError } from "./service";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/utils/constants";
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
  experienceLevel: string | null;
  techStack: string[];
  questionCount: number | null;
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

/** One finalized native-realtime line, as delivered by the room client. */
export interface RealtimeTranscriptMessage {
  speaker: "candidate" | "interviewer";
  contentText: string;
  /** Client-generated event id: repeated deliveries are idempotent. */
  clientId: string;
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
  /** Opens the next unit and stores its first message in ONE locked transaction. */
  appendInterviewerWithNewUnit(
    sessionId: string,
    contentText: string,
  ): Promise<TranscriptEntry>;
  activeUnit(sessionId: string): Promise<string | null>;
  // Both sides combined: the atomic open+append used by the runtime batch for
  // primary questions, plus our explicit unit lifecycle/rollback hooks used for
  // conflict recovery. `unitNumber` is optional so legacy callers still work.
  openUnit(sessionId: string, unitNumber?: number): Promise<string>;
  closeUnit(unitId: string): Promise<void>;
  /**
   * Deletes a unit opened for a primary question whose reply never persisted,
   * so the retry can re-open the same unit number instead of colliding with an
   * empty orphaned unit.
   */
  rollbackUnit(unitId: string): Promise<void>;
  complete(sessionId: string): Promise<void>;
  /**
   * Deletes the candidate message identified by (session, idempotency key)
   * when its turn could not be completed (unit conflict). Returns whether a
   * row was removed, so the caller can reject instead of persisting an
   * unanswered candidate message.
   */
  rollbackCandidate(sessionId: string, idempotencyKey: string): Promise<boolean>;
  /** Appends one finalized native-realtime line (idempotent on clientId). */
  appendRealtimeMessage(
    sessionId: string,
    message: RealtimeTranscriptMessage,
  ): Promise<TranscriptEntry>;
  /** Positional form retained for pre-merge callers and DB tests. */
  appendRealtimeMessage(
    sessionId: string,
    speaker: "candidate" | "interviewer",
    contentText: string,
    clientId: string,
  ): Promise<TranscriptEntry>;
}

export interface RoomTurnInput {
  contentText: string;
  idempotencyKey?: string;
}

export interface RoomTurnResult {
  messages: TranscriptEntry[];
  endCall: boolean;
  created: boolean;
  /** MP3 bytes of the interviewer turn, base64 — null when no voice is configured. */
  audioBase64: string | null;
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
    // Keep the LLM-facing "transition" vocabulary from the runtime batch, but
    // map it to the DB domain (`acknowledgement`) before persisting — a closing
    // remark is never independently evaluated (FR-TRANSCRIPT-004).
    messageKind: z.enum(["primary_question", "follow_up_question", "transition"]),
    endCall: z.boolean(),
  })
  .strict();
export type RoomLlmOutput = z.infer<typeof roomLlmOutputSchema>;

/** Voice is opt-in at the route boundary: no TTS config means no audio, not a failure. */
export interface RoomTtsDeps {
  resolveRoute: (userId: string) => Promise<ProviderRoute | null>;
  synthesize: (route: ProviderRoute, text: string) => Promise<Uint8Array>;
}

export interface RoomDeps {
  store?: RoomStore;
  resolveRoute?: (userId: string) => Promise<ProviderRoute>;
  generate?: (
    route: ProviderRoute,
    options: StructuredOptions<RoomLlmOutput>,
  ) => Promise<RoomLlmOutput>;
  tts?: RoomTtsDeps;
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
    `Target role: ${context.jobRole}. Experience level: ${context.experienceLevel ?? "not supplied"}. Topics: ${context.techStack.join(", ") || "not supplied"}. Target question count: ${context.questionCount ?? "not specified"}. Evaluation mode: ${context.evaluationMode}.`,
    "Ask short, focused questions and never invent facts about the candidate.",
    "Use primary_question only for a new assessment area; use follow_up_question to probe the candidate's last answer. A brief closing remark may be a transition (stored as an acknowledgement, never independently evaluated).",
    primaryCount >= MAX_PRIMARY_QUESTIONS
      ? "The interview is complete: reply with a brief follow_up_question that closes the conversation (for example, thanking the candidate) and set endCall=true."
      : "Set endCall=true only after the interview is genuinely complete. Choose at most one follow-up per answer.",
  ].join(" ");
}

/**
 * Session instructions for the native realtime (Gemini Live) interviewer
 * (FR-INTERVIEW-003, TT-9). The live model must be configured exactly like
 * the typed-path interviewer: same role, same context, same question budget.
 * The SDK delivers the config twice — baked into the server-minted client
 * secret and sent as a `session-update` by the browser (both paths verified
 * in the AI SDK source) — so this one builder is the single source of truth
 * for what the live interviewer is told. The turn-schema vocabulary
 * (primary_question/follow_up_question/endCall) is typed-path specific and
 * deliberately absent here.
 */
export function buildLiveInterviewInstructions(context: RoomContext): string {
  return [
    "You are the AIMIS AI interviewer conducting a live voice mock interview.",
    `Target role: ${context.jobRole}. Job description: ${context.jobDescription ?? "not supplied"}. Evaluation mode: ${context.evaluationMode}.`,
    "This is a mock interview: interview the candidate about the target role, not a real hiring decision.",
    "Ask short, focused questions one at a time and never invent facts about the candidate.",
    `Ask at most ${MAX_PRIMARY_QUESTIONS} main questions in total. Close the interview briefly once you have asked them.`,
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
          .regex(IDEMPOTENCY_KEY_PATTERN)
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
      return {
        messages: await store.messages(context.sessionId),
        endCall: true,
        created: false,
        audioBase64: null,
      };
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

  // Voice resolution and wire pre-flight happen BEFORE any write
  // (fail closed, FR-PROVIDER-006): when the configured voice provider has
  // no implemented wire, the turn is rejected with a typed error — nothing
  // is persisted, so the candidate loses nothing. A MISSING tts
  // configuration is not an error: the turn runs text-only (FR-INTERVIEW-003
  // — audio is an enhancement, never a blocker). Resolved inside the claim
  // scope so a rejection still releases the turn claim instead of making the
  // retry wait for the lease to expire.
  let ttsRoute: ProviderRoute | null = null;

  try {
    if (deps.tts) {
      ttsRoute = await deps.tts.resolveRoute(context.userId);
      if (ttsRoute) assertTtsWireSupported(ttsRoute);
    }

    // Atomic admission BEFORE the candidate row is inserted: a concurrent
    // completion must win (no candidate row), and an already-active interview
    // must not have startedAt reset by this retry.
    if (context.status === "scheduled" || context.status === "active") {
      const admitted = await store.activate(context.sessionId);
      if (admitted === "rejected") {
        if (existing) {
          return {
        messages: await store.messages(context.sessionId),
        endCall: true,
        created: false,
        audioBase64: null,
      };
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
        // The reply landed. Re-assert the completion write in case it failed
        // after the reply persisted: completion is conditional and idempotent,
        // and a closing turn must not replay as an open one.
        const closing =
          history.filter((m) => m.messageKind === "primary_question").length >=
          MAX_PRIMARY_QUESTIONS;
        if (closing) await store.complete(context.sessionId);
        return {
          messages: await store.messages(context.sessionId),
          endCall: closing,
          created: false,
          audioBase64: null,
        };
      }
    }

    return await completeTurn(context, {
      store,
      deps,
      parsed,
      activeUnitId,
      created: candidate.created,
      ttsRoute,
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
    ttsRoute: ProviderRoute | null;
  },
): Promise<RoomTurnResult> {
  const { store, deps, parsed, activeUnitId, created, ttsRoute } = parts;
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
    } satisfies ProviderRoute;
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
  // Runtime-batch kind mapping plus our rollback guarantees, combined.
  let persistedKind: "primary_question" | "follow_up_question" | "acknowledgement" =
    output.messageKind === "transition" ? "acknowledgement" : output.messageKind;
  // A follow-up needs an active unit to join; without one the question opens a
  // unit so no question ends up unassessable.
  if (persistedKind === "follow_up_question" && !unitId) persistedKind = "primary_question";
  if (persistedKind === "primary_question") {
    // A completed interview must not gain a seventh primary question: the sixth
    // is askable and answerable, and the NEXT primary closes the interview.
    if (primaryCount >= MAX_PRIMARY_QUESTIONS && !output.endCall) {
      if (parsed.idempotencyKey) {
        await store.rollbackCandidate(context.sessionId, parsed.idempotencyKey);
      }
      throw new RoomError(
        "invalid_state",
        "The interviewer produced an unexpected primary question after the final question.",
      );
    }
    // One locked write (appendInterviewerWithNewUnit): a concurrent realtime
    // line cannot close the unit between opening it and attaching the question.
    try {
      const entry = await store.appendInterviewerWithNewUnit(
        context.sessionId,
        output.interviewerText,
      );
      unitId = entry.assessmentUnitId;
    } catch (error) {
      // Only a unit-number collision is a concurrency conflict. Other failures
      // propagate untouched and must NOT roll the candidate row back.
      if (!(error instanceof UnitConflictError) || !parsed.idempotencyKey) throw error;
      const rolledBack = await store.rollbackCandidate(context.sessionId, parsed.idempotencyKey);
      if (!rolledBack) throw error;
      throw new RoomError(
        "invalid_state",
        "Another response was processed at the same moment. Send your answer again.",
      );
    }
  } else {
    if (persistedKind === "acknowledgement") unitId = null;
    await store.appendInterviewer(
      context.sessionId,
      output.interviewerText,
      persistedKind,
      unitId,
    );
  }

  // Voice is an enhancement on top of the persisted transcript: a failing
  // TTS call never blocks the conversation (FR-INTERVIEW-003). The provider
  // wire was pre-checked above; only a transport/provider failure is caught.
  let audioBase64: string | null = null;
  if (deps.tts && ttsRoute) {
    try {
      const audio = await deps.tts.synthesize(ttsRoute, output.interviewerText);
      audioBase64 = Buffer.from(audio).toString("base64");
    } catch (error) {
      if (error instanceof TtsError && error.code === "unsupported_provider") throw error;
      audioBase64 = null;
    }
  }

  // The sixth question completes the interview once ANSWERED: when the model
  // asks primary #6 and endCall arrives with that answer's turn, both the
  // reply and the completion land atomically here.
  const endCall = output.endCall || primaryCount + 1 > MAX_PRIMARY_QUESTIONS;
  if (endCall) await store.complete(context.sessionId);
  return { messages: await store.messages(context.sessionId), endCall, created, audioBase64 };
}
