import { z } from "zod";
import {
  Prisma,
  type ConversationMessage,
  type InterviewCategory,
  type InterviewSession,
} from "@/generated/prisma/client";
import { db } from "@/lib/db";
// Combined: the runtime-batch route snapshot (runtime-mode selection) and our
// review fixes (idempotent creation, locked transcript appends) both stay.
import {
  getActiveRuntimeMode,
  listProviderConfigurations,
} from "@/lib/providers/config";
import { getPresetAdapter } from "@/lib/providers/registry";
import { selectRuntime } from "./runtime";
import {
  createInvitationToken,
  hashInvitationToken,
  invitationPath,
} from "./invitation-token";
import type {
  RealtimeTranscriptMessage,
  RoomStore,
  TranscriptEntry,
} from "./room";
import { findActiveSessionByToken, issueInvitation, type IssuedInvitation } from "./invitations";
// Runtime-batch utterance classification: a realtime acknowledgement is never
// stored as an assessable question (FR-TRANSCRIPT-004).
import { classifyInterviewerUtterance } from "./realtime-transcript";
import { UnitConflictError } from "./unit-conflict";
import {
  interviewSetupSchema,
  typedTurnSchema,
  type InterviewSetupInput,
  type RuntimeMode,
  type TypedTurnInput,
} from "./validation";

/**
 * Minimal typed-interview path (backlog slice 7; M1 exit evidence):
 * session creation from the candidate's saved setup (FR-SETUP-001..005),
 * explicit start/finish lifecycle (FR-INTERVIEW-001/011) and typed turn
 * submission persisted chronologically as the transcript (FR-INTERVIEW-004).
 *
 * The AI interviewer itself (question generation, follow-ups,
 * acknowledgements) is M2 (backlog slices 9-10) — this module owns the data
 * path those features hang off: snapshot columns, sequence numbering and
 * idempotent, retriable submissions (NFR-REL-002).
 */

export type InterviewErrorCode =
  | "invalid_input"
  | "not_found"
  | "invalid_state"
  | "client_id_conflict"
  | "provider_route_missing";

export class InterviewError extends Error {
  readonly code: InterviewErrorCode;

  constructor(code: InterviewErrorCode, message: string) {
    super(message);
    this.name = "InterviewError";
    this.code = code;
  }
}

/**
 * Prompt provenance label for sessions created before the interviewer
 * prompt registry exists (M2). Engineering placeholder — flagged in the
 * slice report; the column is NOT NULL in schema v0.4.
 */
export const INTERVIEWER_PROMPT_VERSION = "v0-typed-slice";

/**
 * The provider route captured at creation time. Deliberately excludes the
 * API key: credentials stay write-only and are decrypted only immediately
 * before an outbound call (ADR-0005, NFR-SEC-003).
 */
export interface ProviderRouteSnapshot {
  // Both runtimes are snapshotted at creation (ADR-006): exactly one is active.
  capability: "llm" | "realtime";
  providerName: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
}

/** Creation returns the one-time shareable link alongside the key-free summary. */
export type CreatedInterview = SessionSummary & { invitation: IssuedInvitation };

export interface SessionSummary {
  sessionId: string;
  jobRole: string;
  jobDescription: string | null;
  experienceLevel: string | null;
  techStack: string[];
  questionCount: number | null;
  categoryId: string;
  categoryCodeSnapshot: string;
  categoryNameSnapshot: string;
  evaluationMode: string;
  runtimeMode: RuntimeMode;
  providerRouteSnapshot: ProviderRouteSnapshot;
  interviewerPromptVersion: string;
  status: string;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TranscriptMessage {
  messageId: string;
  sequenceNumber: number;
  speakerType: string;
  messageKind: string;
  contentText: string;
  candidateInputMode: string | null;
}

export interface InterviewCategorySummary {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  description: string | null;
}

function toSessionSummary(
  session: InterviewSession,
  providerRouteSnapshot: ProviderRouteSnapshot,
): SessionSummary {
  return {
    sessionId: session.sessionId,
    jobRole: session.jobRole,
    jobDescription: session.jobDescription,
    experienceLevel: session.experienceLevel,
    techStack: Array.isArray(session.techStack)
      ? (session.techStack as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    questionCount: session.questionCount,
    categoryId: session.categoryId,
    categoryCodeSnapshot: session.categoryCodeSnapshot,
    categoryNameSnapshot: session.categoryNameSnapshot,
    evaluationMode: session.evaluationMode,
    runtimeMode: session.runtimeMode as RuntimeMode,
    providerRouteSnapshot,
    interviewerPromptVersion: session.interviewerPromptVersion,
    status: session.status,
    failureCode: session.failureCode,
    createdAt: session.createdAt.toISOString(),
    startedAt: session.startedAt?.toISOString() ?? null,
    completedAt: session.completedAt?.toISOString() ?? null,
  };
}

function toMessageSummary(message: ConversationMessage): TranscriptMessage {
  return {
    messageId: message.messageId,
    sequenceNumber: message.sequenceNumber,
    speakerType: message.speakerType,
    messageKind: message.messageKind,
    contentText: message.contentText,
    candidateInputMode: message.candidateInputMode,
  };
}

/**
 * Active interview categories for the setup screen (FR-SETUP-003). Admin
 * category management is deferred (TT-7); the approved three categories are
 * seeded by migration.
 */
export async function listActiveInterviewCategories(): Promise<InterviewCategorySummary[]> {
  const rows = await db.interviewCategory.findMany({
    where: { isActive: true },
    orderBy: [{ displayOrder: "asc" }, { categoryName: "asc" }],
  });
  return rows.map((row) => ({
    categoryId: row.categoryId,
    categoryCode: row.categoryCode,
    categoryName: row.categoryName,
    description: row.description,
  }));
}

async function loadOwnedSession(
  userId: string,
  sessionId: string,
): Promise<InterviewSession> {
  let parsedId: string;
  try {
    parsedId = z.uuid().parse(sessionId);
  } catch {
    throw new InterviewError("not_found", "Interview session not found.");
  }
  const session = await db.interviewSession.findUnique({ where: { sessionId: parsedId } });
  if (!session || session.userId !== userId) {
    // Ownership scoping: foreign sessions look exactly like missing ones.
    throw new InterviewError("not_found", "Interview session not found.");
  }
  return session;
}

/**
 * Snapshots the ONE selected runtime (ADR-006): a native realtime agent or the
 * custom LLM pipeline. Kept from the runtime batch so a realtime-only candidate
 * can still create a session; no credential is decrypted here (ADR-0005).
 */
async function selectRouteSnapshot(
  userId: string,
): Promise<{ snapshot: ProviderRouteSnapshot; runtimeMode: RuntimeMode }> {
  const activeMode = await getActiveRuntimeMode(userId);
  const runtime = selectRuntime(await listProviderConfigurations(userId), activeMode);
  if (!runtime.ready || !runtime.row) {
    throw new InterviewError(
      "provider_route_missing",
      runtime.mode === "realtime"
        ? "The realtime agent configuration is not usable yet."
        : "Configure a realtime agent or an LLM provider before starting an interview.",
    );
  }
  const row = runtime.row;
  const capability = runtime.mode === "realtime" ? "realtime" : "llm";
  const baseUrl =
    row.providerType === "custom"
      ? row.baseUrl
      : getPresetAdapter(row.providerName)?.defaultBaseUrl ?? null;
  if (!baseUrl) {
    throw new InterviewError(
      "provider_route_missing",
      "The selected provider has no usable endpoint.",
    );
  }
  return {
    snapshot: {
      capability,
      providerName: row.providerName,
      providerType: row.providerType,
      baseUrl,
      modelId: row.capabilities[capability]?.modelId ?? "",
    },
    // Keep the runtime the account actually selected: a mixed row must not
    // turn a custom-mode interview into a realtime one.
    runtimeMode: runtime.mode === "realtime" ? "preset_realtime" : "custom",
  };
}

/** Normalizes and validates a candidate-supplied creation idempotency key. */
function normalizeCreationKey(idempotencyKey?: string): string | null {
  const key = idempotencyKey?.trim() || null;
  if (key && (key.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(key))) {
    throw new InterviewError("invalid_input", "Invalid creation idempotency key.");
  }
  return key;
}

/** True when a P2002 came from the (user, creation idempotency key) index. */
function isCreationKeyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = JSON.stringify(error.meta ?? {});
  return (
    target.includes("creation_idempotency_key") ||
    target.includes("creationIdempotencyKey")
  );
}

/**
 * Loads the session that already owns (userId, key) and reissues its link.
 * The raw token is deliberately never stored, so a replay issues a fresh
 * capability for the SAME session instead of creating a duplicate.
 */
async function replayCreatedInterview(
  userId: string,
  key: string,
): Promise<CreatedInterview | null> {
  const existing = await db.interviewSession.findFirst({
    where: { userId, creationIdempotencyKey: key },
  });
  if (!existing) return null;
  const reissued = await issueInvitation(userId, existing.sessionId);
  return {
    ...toSessionSummary(existing, existing.providerRouteSnapshot as unknown as ProviderRouteSnapshot),
    invitation: reissued,
  };
}

/**
 * Replay lookup for callers that must decide whether a request would create a
 * new session before applying creation-only preconditions (the agent checks
 * category availability only for NEW sessions).
 */
export async function findExistingInterviewCreation(
  userId: string,
  idempotencyKey?: string,
): Promise<CreatedInterview | null> {
  const key = normalizeCreationKey(idempotencyKey);
  return key ? replayCreatedInterview(userId, key) : null;
}

/**
 * Creates a session from the candidate's setup (FR-SETUP-001..005,
 * FR-INTERVIEW-001). The category is snapshotted by value and the provider
 * route resolved up front: a session without a usable LLM route cannot be
 * interviewed in M2, so creation fails closed instead of deferring the
 * failure.
 */
export async function createInterviewSession(
  userId: string,
  input: unknown,
  idempotencyKey?: string,
): Promise<CreatedInterview> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new InterviewError("invalid_input", "Invalid user id.");
  }

  let parsed: InterviewSetupInput;
  try {
    parsed = interviewSetupSchema.parse(input);
  } catch (error) {
    throw new InterviewError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid interview setup.",
    );
  }

  // Idempotent creation: a retried "create" request returns the original
  // session (and a freshly issued link) instead of a duplicate. The raw token
  // is deliberately never stored, so a replay reissues it for the SAME session.
  const key = normalizeCreationKey(idempotencyKey);
  if (key) {
    const existing = await replayCreatedInterview(userId, key);
    if (existing) return existing;
  }

  const category: InterviewCategory | null = await db.interviewCategory.findUnique({
    where: { categoryId: parsed.categoryId },
  });
  if (!category || !category.isActive) {
    throw new InterviewError("invalid_input", "Select an active interview category.");
  }

  // Combine: the runtime snapshot (which runtime actually has a usable route)
  // wins over the candidate's requested mode, while idempotent creation and
  // the generation fields from both sides are preserved.
  const { snapshot: providerRouteSnapshot, runtimeMode } = await selectRouteSnapshot(userId);

  // FR-SETUP-007/008: the interview is born scheduled/ready, with a
  // revocable link whose raw capability is never stored (only its hash).
  const invitationToken = createInvitationToken();
  let session: InterviewSession;
  try {
    session = await db.interviewSession.create({
      data: {
        userId,
        jobRole: parsed.jobRole,
        jobDescription: parsed.jobDescription ?? null,
        experienceLevel: parsed.experienceLevel ?? null,
        techStack: parsed.techStack ? (parsed.techStack as unknown as Prisma.InputJsonValue) : undefined,
        questionCount: parsed.questionCount ?? null,
        categoryId: category.categoryId,
        categoryCodeSnapshot: category.categoryCode,
        categoryNameSnapshot: category.categoryName,
        evaluationMode: parsed.evaluationMode,
        runtimeMode,
        providerRouteSnapshot:
          providerRouteSnapshot as unknown as Prisma.InputJsonValue,
        interviewerPromptVersion: INTERVIEWER_PROMPT_VERSION,
        status: "scheduled",
        invitationTokenHash: hashInvitationToken(invitationToken),
        creationIdempotencyKey: key,
      },
    });
  } catch (error) {
    // A concurrent request with the same key won the partial unique index:
    // replay the winner instead of surfacing a spurious conflict. Any other
    // database failure propagates unchanged.
    if (isCreationKeyConflict(error) && key) {
      const winner = await replayCreatedInterview(userId, key);
      if (winner) return winner;
    }
    throw error;
  }
  return {
    ...toSessionSummary(session, providerRouteSnapshot),
    invitation: { token: invitationToken, path: invitationPath(invitationToken) },
  };
}

/**
 * Marks a scheduled session active (FR-INTERVIEW-001). kept separate from
 * creation so a runtime setup failure (M2) can land the session in
 * `failed` without ever having started. `created` is a legacy status retained
 * for sessions made before the default changed to `scheduled`.
 */
export async function startInterviewSession(
  userId: string,
  sessionId: string,
): Promise<SessionSummary> {
  const session = await loadOwnedSession(userId, sessionId);
  if (session.status !== "scheduled" && session.status !== "created") {
    throw new InterviewError("invalid_state", "Only a scheduled interview can be started.");
  }
  // Atomic lifecycle predicate: a concurrent completion/start cannot be
  // overwritten back to active, and a double-start cannot reset startedAt.
  const updated = await db.interviewSession.updateMany({
    where: { sessionId: session.sessionId, status: { in: ["scheduled", "created"] } },
    data: { status: "active", startedAt: new Date() },
  });
  if (updated.count === 0) {
    throw new InterviewError("invalid_state", "Only a scheduled interview can be started.");
  }
  const started = await db.interviewSession.findUniqueOrThrow({
    where: { sessionId: session.sessionId },
  });
  return toSessionSummary(
    started,
    started.providerRouteSnapshot as unknown as ProviderRouteSnapshot,
  );
}

/**
 * Ends an active interview (FR-INTERVIEW-011). The DB lifecycle CHECK
 * (completed_at ⇒ started_at) is mirrored: a created session cannot be
 * completed without having started.
 */
export async function endInterviewSession(
  userId: string,
  sessionId: string,
): Promise<SessionSummary> {
  const session = await loadOwnedSession(userId, sessionId);
  // FR-INTERVIEW-011: a repeated end request is idempotent — an already
  // completed interview returns its stored state instead of a second
  // completion event or an error.
  if (session.status === "completed") {
    return toSessionSummary(
      session,
      session.providerRouteSnapshot as unknown as ProviderRouteSnapshot,
    );
  }
  if (session.status !== "active") {
    throw new InterviewError("invalid_state", "Only an active interview can be ended.");
  }
  const ended = await db.interviewSession.update({
    where: { sessionId: session.sessionId },
    data: { status: "completed", completedAt: new Date() },
  });
  return toSessionSummary(
    ended,
    ended.providerRouteSnapshot as unknown as ProviderRouteSnapshot,
  );
}

/**
 * Shared message insertion with conflict handling (FR-TRANSCRIPT-001,
 * NFR-REL-002). Retried submissions with the same idempotency key return the
 * original message instead of duplicating it (the partial unique index on
 * (session_id, idempotency_key)); a sequence-number collision (concurrent
 * turns) is retried once against a fresh max before surfacing as a conflict.
 * Shared by the typed turn path (submitTypedTurn) and the token-scoped room
 * store so both stay safe under concurrent inserts.
 */
async function appendMessage(
  sessionId: string,
  data: {
    speakerType: string;
    messageKind: string;
    contentText: string;
    candidateInputMode?: string | null;
    idempotencyKey?: string | null;
    assessmentUnitId?: string | null;
  },
  options: { requireActiveSession?: boolean } = {},
): Promise<{ message: ConversationMessage; created: boolean }> {
  if (data.idempotencyKey) {
    const existing = await db.conversationMessage.findFirst({
      where: { sessionId, idempotencyKey: data.idempotencyKey },
    });
    if (existing) return { message: existing, created: false };
  }

  const insert = async (
    client: Pick<Prisma.TransactionClient, "conversationMessage">,
  ) => {
    const aggregate = await client.conversationMessage.aggregate({
      where: { sessionId },
      _max: { sequenceNumber: true },
    });
    return client.conversationMessage.create({
      data: {
        sessionId,
        sequenceNumber: (aggregate._max.sequenceNumber ?? 0) + 1,
        speakerType: data.speakerType,
        messageKind: data.messageKind,
        contentText: data.contentText,
        candidateInputMode: data.candidateInputMode ?? null,
        idempotencyKey: data.idempotencyKey ?? null,
        assessmentUnitId: data.assessmentUnitId ?? null,
      },
    });
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const message = options.requireActiveSession
        ? await db.$transaction(async (tx) => {
            // Lock the parent session row so completion is ordered against this
            // insert: either the insert sees an active session and wins, or a
            // concurrent completion commits first and this is rejected without
            // writing a row.
            await tx.$queryRaw`SELECT session_id FROM interview_session WHERE session_id = ${sessionId}::uuid FOR UPDATE`;
            const session = await tx.interviewSession.findUnique({
              where: { sessionId },
              select: { status: true },
            });
            if (session?.status !== "active") {
              throw new InterviewError(
                "invalid_state",
                "This interview is not accepting turns.",
              );
            }
            return insert(tx);
          })
        : await insert(db);
      return { message, created: true };
    } catch (error) {
      const isDuplicate =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      // The partial unique index on (session_id, idempotency_key) carries
      // "idempotency" in its name; sequence violations carry "sequence".
      const violation = JSON.stringify(
        error instanceof Error && "meta" in error ? (error as { meta?: unknown }).meta : "",
      );
      const duplicateIdempotency = isDuplicate && violation.includes("idempotency");
      if (duplicateIdempotency) {
        // A concurrent duplicate insert: return the winner instead of a 500.
        const existing = await db.conversationMessage.findFirst({
          where: { sessionId, idempotencyKey: data.idempotencyKey ?? undefined },
        });
        if (existing) return { message: existing, created: false };
      }
      const duplicateSequence = isDuplicate && violation.includes("sequence");
      if (attempt === 0 && duplicateSequence) {
        continue; // recompute max sequence after a concurrent insert
      }
      if (duplicateSequence) {
        throw new InterviewError(
          "invalid_state",
          "The response could not be ordered. Try again.",
        );
      }
      // Not a sequence collision (connection, other constraint, timeout): let
      // the database failure propagate as a genuine server error (review fix).
      throw error;
    }
  }
  throw new InterviewError("invalid_state", "The response could not be ordered. Try again.");
}

/**
 * Persists one typed candidate response (FR-INTERVIEW-004) on the shared
 * appendMessage conflict path.
 */
export async function submitTypedTurn(
  userId: string,
  sessionId: string,
  input: unknown,
): Promise<{ message: TranscriptMessage; created: boolean }> {
  const session = await loadOwnedSession(userId, sessionId);
  if (session.status !== "active") {
    throw new InterviewError(
      "invalid_state",
      session.status === "completed"
        ? "The interview has ended."
        : "Start the interview before submitting responses.",
    );
  }

  let parsed: TypedTurnInput;
  try {
    parsed = typedTurnSchema.parse(input);
  } catch (error) {
    throw new InterviewError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid interview turn.",
    );
  }

  const result = await appendMessage(
    session.sessionId,
    {
      speakerType: "candidate",
      messageKind: "candidate_response",
      contentText: parsed.contentText,
      candidateInputMode: parsed.inputMode,
      idempotencyKey: parsed.idempotencyKey ?? null,
    },
    { requireActiveSession: true },
  );
  return { message: toMessageSummary(result.message), created: result.created };
}

/**
 * Persistence for the token-scoped room (FR-INTERVIEW-004), sharing
 * appendMessage with the typed path. The token is resolved to the owning
 * session by invitations.findActiveSessionByToken — no account session.
 *
 * In-process serialisation of realtime transcript writes follows, one chain per
 * session. Finalized live lines arrive concurrently — a batch inserts them in
 * order — so sequence/unit allocation must not interleave: out-of-order
 * allocation would leave a sequence gap and replay the transcript unordered. A
 * writer queues behind the previous write of the SAME session; a failed write
 * still releases the next one immediately. The bounded P2002 retry below stays
 * as the cross-process safety net.
 */
const realtimeWriteChains = new Map<string, Promise<void>>();

function serializeRealtimeWrite<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
  const previous = realtimeWriteChains.get(sessionId) ?? Promise.resolve();
  const run = previous.then(write, write);
  // The chain link never rejects: the caller owns the result, the next writer
  // must not inherit this write's failure.
  realtimeWriteChains.set(sessionId, run.then(() => undefined, () => undefined));
  return run;
}

export function createRoomStore(): RoomStore {
  return {
    async context(token) {
      const session = await findActiveSessionByToken(token);
      if (!session) return null;
      return {
        sessionId: session.sessionId,
        userId: session.userId,
        jobRole: session.jobRole,
        jobDescription: session.jobDescription,
        experienceLevel: session.experienceLevel,
        techStack: Array.isArray(session.techStack)
          ? session.techStack.filter((value): value is string => typeof value === "string")
          : [],
        questionCount: session.questionCount,
        evaluationMode: session.evaluationMode,
        runtimeMode: session.runtimeMode,
        status: session.status,
      };
    },

    async messages(sessionId) {
      const rows = await db.conversationMessage.findMany({
        where: { sessionId },
        orderBy: { sequenceNumber: "asc" },
        select: {
          sequenceNumber: true,
          speakerType: true,
          messageKind: true,
          contentText: true,
          assessmentUnitId: true,
        },
      });
      return rows.map((message) => ({
        sequenceNumber: message.sequenceNumber,
        speakerType: message.speakerType,
        messageKind: message.messageKind,
        contentText: message.contentText,
        assessmentUnitId: message.assessmentUnitId,
      }));
    },

    async findCandidateByKey(sessionId, idempotencyKey) {
      const message = await db.conversationMessage.findFirst({
        where: { sessionId, idempotencyKey, speakerType: "candidate" },
        select: {
          sequenceNumber: true,
          speakerType: true,
          messageKind: true,
          contentText: true,
          assessmentUnitId: true,
        },
      });
      if (!message) return null;
      return {
        sequenceNumber: message.sequenceNumber,
        speakerType: message.speakerType,
        messageKind: message.messageKind,
        contentText: message.contentText,
        assessmentUnitId: message.assessmentUnitId,
      };
    },

    async activate(sessionId) {
      // Atomic admission: only scheduled/created transitions to active, and the
      // startedAt timestamp is only written on the transition. An already-active
      // interview is a no-op (NOT a startedAt reset); a completed one is refused
      // before any candidate row can be inserted (review fix).
      const updated = await db.interviewSession.updateMany({
        where: { sessionId, status: { in: ["scheduled", "created"] } },
        data: { status: "active", startedAt: new Date() },
      });
      if (updated.count === 1) return "activated" as const;

      const current = await db.interviewSession.findUnique({
        where: { sessionId },
        select: { status: true },
      });
      if (!current) return "rejected" as const;
      return current.status === "active" ? ("already_active" as const) : ("rejected" as const);
    },

    async appendCandidate(sessionId, contentText, idempotencyKey, assessmentUnitId) {
      const result = await appendMessage(
        sessionId,
        {
          speakerType: "candidate",
          messageKind: "candidate_response",
          contentText,
          idempotencyKey: idempotencyKey ?? null,
          assessmentUnitId,
        },
        { requireActiveSession: true },
      );
      return {
        entry: {
          sequenceNumber: result.message.sequenceNumber,
          speakerType: result.message.speakerType,
          messageKind: result.message.messageKind,
          contentText: result.message.contentText,
          assessmentUnitId: result.message.assessmentUnitId,
        },
        created: result.created,
      };
    },

    async appendInterviewer(sessionId, contentText, messageKind, assessmentUnitId) {
      const result = await appendMessage(sessionId, {
        speakerType: "interviewer",
        messageKind,
        contentText,
        assessmentUnitId,
      });
      return {
        sequenceNumber: result.message.sequenceNumber,
        speakerType: result.message.speakerType,
        messageKind: result.message.messageKind,
        contentText: result.message.contentText,
        assessmentUnitId: result.message.assessmentUnitId,
      };
    },

    /** Opens the next assessment unit and stores its first question atomically. */
    async appendInterviewerWithNewUnit(sessionId, contentText) {
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT session_id FROM interview_session WHERE session_id = ${sessionId}::uuid FOR UPDATE`;
        // Re-check status under the same row lock as appendRealtimeMessage: a
        // completion that committed while the answer was generated must not
        // add a primary question or open a unit on a finished interview.
        const session = await tx.interviewSession.findUnique({
          where: { sessionId },
          select: { status: true },
        });
        if (session?.status !== "active") {
          throw new InterviewError("invalid_state", "This interview is not accepting turns.");
        }
        await tx.interviewAssessmentUnit.updateMany({
          where: { sessionId, status: "open" },
          data: { status: "closed", closedAt: new Date() },
        });
        const maxUnit = await tx.interviewAssessmentUnit.aggregate({
          where: { sessionId },
          _max: { unitNumber: true },
        });
        const unit = await tx.interviewAssessmentUnit.create({
          data: { sessionId, unitNumber: (maxUnit._max.unitNumber ?? 0) + 1 },
          select: { assessmentUnitId: true },
        });
        const maxSeq = await tx.conversationMessage.aggregate({
          where: { sessionId },
          _max: { sequenceNumber: true },
        });
        const message = await tx.conversationMessage.create({
          data: {
            sessionId,
            sequenceNumber: (maxSeq._max.sequenceNumber ?? 0) + 1,
            speakerType: "interviewer",
            messageKind: "primary_question",
            contentText,
            assessmentUnitId: unit.assessmentUnitId,
          },
        });
        return {
          sequenceNumber: message.sequenceNumber,
          speakerType: message.speakerType,
          messageKind: message.messageKind,
          contentText: message.contentText,
          assessmentUnitId: message.assessmentUnitId,
        };
      });
    },

    /**
     * Appends one finalized native-realtime line, idempotent on the client id.
     * Both call shapes are supported: the object form used by the transcript
     * route and the positional form used by earlier callers/DB tests. A reused
     * id with different content/speaker is a visible conflict; interviewer text
     * is classified so an acknowledgement never becomes a primary question.
     * Admission is RUNNING-only and re-checked under the session row lock.
     */
    async appendRealtimeMessage(
      sessionId,
      messageOrSpeaker: RealtimeTranscriptMessage | "candidate" | "interviewer",
      positionalContent?: string,
      positionalClientId?: string,
    ) {
      const isPositional = typeof messageOrSpeaker === "string";
      const message: RealtimeTranscriptMessage = isPositional
        ? {
            speaker: messageOrSpeaker,
            contentText: positionalContent ?? "",
            clientId: positionalClientId ?? "",
          }
        : messageOrSpeaker;
      const { speaker, contentText, clientId } = message;
      // Content-aware classification is opt-in via the object form (the native
      // realtime wire); the positional form keeps its legacy unit semantics.
      const classifyKind = !isPositional;
      const toEntry = (message: {
        sequenceNumber: number;
        speakerType: string;
        messageKind: string;
        contentText: string;
        assessmentUnitId: string | null;
      }): TranscriptEntry => ({
        sequenceNumber: message.sequenceNumber,
        speakerType: message.speakerType,
        messageKind: message.messageKind,
        contentText: message.contentText,
        assessmentUnitId: message.assessmentUnitId,
      });

      // Finalized live lines arrive concurrently with each other and with the
      // typed path. Locking the parent session row serialises BOTH the sequence
      // allocation and the unit-number allocation for the whole write;
      // chaining writers per session keeps a delivered batch in order; and
      // the bounded retry re-reads the idempotency key and the max values when
      // a unique constraint is still lost to another writer — a finalized line
      // is never dropped on a sequence/unit collision.
      for (let attempt = 0; ; attempt++) {
        try {
          return await serializeRealtimeWrite(sessionId, () => db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT session_id FROM interview_session WHERE session_id = ${sessionId}::uuid FOR UPDATE`;
            const session = await tx.interviewSession.findUnique({
              where: { sessionId },
              select: { status: true },
            });
            if (session?.status !== "active") {
              // A completion that committed first wins: the finalized line is
              // rejected instead of landing on a finished transcript.
              throw new InterviewError("invalid_state", "This interview is not accepting turns.");
            }

            const existing = await tx.conversationMessage.findFirst({
              where: { sessionId, idempotencyKey: clientId },
            });
            if (existing) {
              // A replay must carry the SAME speaker and content. A document
              // reload can reuse a client id after the old answer was already
              // stored; silently returning that row would discard the new
              // answer. Refuse the collision so it is visible (409) instead.
              if (existing.speakerType !== speaker || existing.contentText !== contentText) {
                throw new InterviewError(
                  "client_id_conflict",
                  "A different message was already saved with this id. The transcript line was not saved.",
                );
              }
              return toEntry(existing);
            }

            const openUnit = await tx.interviewAssessmentUnit.findFirst({
              where: { sessionId, status: "open" },
              orderBy: { unitNumber: "desc" },
              select: { assessmentUnitId: true },
            });
            let messageKind: "candidate_response" | "primary_question" | "follow_up_question" | "acknowledgement";
            let assessmentUnitId: string | null = openUnit?.assessmentUnitId ?? null;
            if (speaker === "candidate") {
              messageKind = "candidate_response";
            } else {
              // Content-aware kind (runtime batch): a conversational reply is an
              // acknowledgement and joins no assessment unit; a follow-up joins
              // the open unit, and a new primary question opens a fresh one.
              const classified = classifyKind
                ? classifyInterviewerUtterance(contentText)
                : "primary_question";
              messageKind = classified === "follow_up_question" && !openUnit
                ? "primary_question"
                : classified;
              if (messageKind === "primary_question") {
                // A new assessment area closes the previous open unit first
                // (one-open-unit partial index), then opens the next numbered
                // one in the same locked transaction.
                await tx.interviewAssessmentUnit.updateMany({
                  where: { sessionId, status: "open" },
                  data: { status: "closed", closedAt: new Date() },
                });
                const maxUnit = await tx.interviewAssessmentUnit.aggregate({
                  where: { sessionId },
                  _max: { unitNumber: true },
                });
                // The unit and its first question are written in the same
                // transaction: a failed message insert rolls the unit back.
                const unit = await tx.interviewAssessmentUnit.create({
                  data: { sessionId, unitNumber: (maxUnit._max.unitNumber ?? 0) + 1 },
                  select: { assessmentUnitId: true },
                });
                assessmentUnitId = unit.assessmentUnitId;
              } else if (messageKind === "acknowledgement") {
                assessmentUnitId = null;
              }
            }

            const aggregate = await tx.conversationMessage.aggregate({
              where: { sessionId },
              _max: { sequenceNumber: true },
            });
            const message = await tx.conversationMessage.create({
              data: {
                sessionId,
                sequenceNumber: (aggregate._max.sequenceNumber ?? 0) + 1,
                speakerType: speaker,
                messageKind,
                contentText,
                idempotencyKey: clientId,
                assessmentUnitId,
              },
            });
            return toEntry(message);
          }));
        } catch (error) {
          const conflict =
            error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
          if (conflict && attempt < 2) continue;
          throw error;
        }
      }
    },

    async activeUnit(sessionId) {
      const unit = await db.interviewAssessmentUnit.findFirst({
        where: { sessionId, status: "open" },
        orderBy: { unitNumber: "desc" },
        select: { assessmentUnitId: true },
      });
      return unit?.assessmentUnitId ?? null;
    },

    async openUnit(sessionId, unitNumber) {
      try {
        // Legacy callers pin a number (DB test asserts the one-open-unit index);
        // new callers let the store allocate the next number atomically.
        let number = unitNumber;
        if (number === undefined) {
          const max = await db.interviewAssessmentUnit.aggregate({
            where: { sessionId },
            _max: { unitNumber: true },
          });
          number = (max._max.unitNumber ?? 0) + 1;
        }
        const unit = await db.interviewAssessmentUnit.create({
          data: { sessionId, unitNumber: number },
          select: { assessmentUnitId: true },
        });
        return unit.assessmentUnitId;
      } catch (error) {
        // Both unique indexes on this table are unit assignments: (session,
        // unit number) and the one-open-unit partial index. A P2002 from this
        // insert is a concurrency conflict; other failures propagate (review fix).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new UnitConflictError();
        }
        throw error;
      }
    },

    async closeUnit(unitId) {
      await db.interviewAssessmentUnit.update({
        where: { assessmentUnitId: unitId },
        data: { status: "closed", closedAt: new Date() },
      });
    },

    async rollbackUnit(unitId) {
      await db.interviewAssessmentUnit.delete({ where: { assessmentUnitId: unitId } });
    },

    async complete(sessionId) {
      // Conditional write: only an active interview completes, and the row lock
      // this update takes is ordered against the candidate-insert transaction,
      // so a completion that wins rejects the insert instead of the insert
      // landing on an already-completed session.
      await db.interviewSession.updateMany({
        where: { sessionId, status: "active" },
        data: { status: "completed", completedAt: new Date() },
      });
    },

    async rollbackCandidate(sessionId, idempotencyKey) {
      const result = await db.conversationMessage.deleteMany({
        where: { sessionId, idempotencyKey, speakerType: "candidate" },
      });
      return result.count > 0;
    },
  };
}

/**
 * The candidate's chronological transcript plus the session it belongs to
 * (ownership-checked; FR-INTERVIEW data stays private to its owner until
 * evaluation/report access exists).
 */
export async function getOwnInterviewTranscript(
  userId: string,
  sessionId: string,
): Promise<{ session: SessionSummary; messages: TranscriptMessage[] }> {
  const session = await loadOwnedSession(userId, sessionId);
  const rows = await db.conversationMessage.findMany({
    where: { sessionId: session.sessionId },
    orderBy: { sequenceNumber: "asc" },
  });
  return {
    session: toSessionSummary(
      session,
      session.providerRouteSnapshot as unknown as ProviderRouteSnapshot,
    ),
    messages: rows.map(toMessageSummary),
  };
}
