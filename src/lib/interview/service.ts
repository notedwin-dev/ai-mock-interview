import { z } from "zod";
import {
  Prisma,
  type ConversationMessage,
  type InterviewCategory,
  type InterviewSession,
} from "@/generated/prisma/client";
import { db } from "@/lib/db";
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
import type { IssuedInvitation } from "./invitations";
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
 * Snapshots the ONE selected runtime (ADR-006): a native realtime agent or
 * the custom LLM pipeline. No credential is decrypted here — the snapshot is
 * display/identity only (ADR-0005).
 */
async function selectRouteSnapshot(
  userId: string,
): Promise<{ snapshot: ProviderRouteSnapshot; runtimeMode: RuntimeMode }> {
  const runtime = selectRuntime(
    await listProviderConfigurations(userId),
    await getActiveRuntimeMode(userId),
  );
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
    runtimeMode: runtime.mode === "realtime" ? "preset_realtime" : "custom",
  };
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

  const category: InterviewCategory | null = await db.interviewCategory.findUnique({
    where: { categoryId: parsed.categoryId },
  });
  if (!category || !category.isActive) {
    throw new InterviewError("invalid_input", "Select an active interview category.");
  }

  const { snapshot: providerRouteSnapshot, runtimeMode } = await selectRouteSnapshot(userId);

  // FR-SETUP-007/008: the interview is born scheduled/ready, with a
  // revocable link whose raw capability is never stored (only its hash).
  const invitationToken = createInvitationToken();
  const session = await db.interviewSession.create({
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
    },
  });
  return {
    ...toSessionSummary(session, providerRouteSnapshot),
    invitation: { token: invitationToken, path: invitationPath(invitationToken) },
  };
}

/**
 * Marks a created session active (FR-INTERVIEW-001). kept separate from
 * creation so a runtime setup failure (M2) can land the session in
 * `failed` without ever having started.
 */
export async function startInterviewSession(
  userId: string,
  sessionId: string,
): Promise<SessionSummary> {
  const session = await loadOwnedSession(userId, sessionId);
  // 'created' is retained for sessions made before the scheduled-state
  // migration; newly created interviews start as 'scheduled'.
  if (session.status !== "scheduled" && session.status !== "created") {
    throw new InterviewError("invalid_state", "Only a scheduled interview can be started.");
  }
  const started = await db.interviewSession.update({
    where: { sessionId: session.sessionId },
    data: { status: "active", startedAt: new Date() },
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

async function nextSequenceNumber(sessionId: string): Promise<number> {
  const aggregate = await db.conversationMessage.aggregate({
    where: { sessionId },
    _max: { sequenceNumber: true },
  });
  return (aggregate._max.sequenceNumber ?? 0) + 1;
}

/**
 * Persists one typed candidate response (FR-INTERVIEW-004). Retried
 * finalized submissions with the same idempotency key return the original
 * message instead of duplicating it (NFR-REL-002 partial unique index);
 * a sequence-number collision (concurrent turns) is retried once against a
 * fresh max before surfacing as a conflict.
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

  if (parsed.idempotencyKey) {
    const existing = await db.conversationMessage.findFirst({
      where: { sessionId: session.sessionId, idempotencyKey: parsed.idempotencyKey },
    });
    if (existing) {
      return { message: toMessageSummary(existing), created: false };
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const message = await db.conversationMessage.create({
        data: {
          sessionId: session.sessionId,
          sequenceNumber: await nextSequenceNumber(session.sessionId),
          speakerType: "candidate",
          messageKind: "candidate_response",
          contentText: parsed.contentText,
          candidateInputMode: parsed.inputMode,
          idempotencyKey: parsed.idempotencyKey ?? null,
        },
      });
      return { message: toMessageSummary(message), created: true };
    } catch (error) {
      const isDuplicate =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      // The partial unique index on (session_id, idempotency_key) carries
      // "idempotency" in its name; sequence violations carry "sequence".
      const violation = JSON.stringify(error instanceof Error && "meta" in error ? (error as { meta?: unknown }).meta : "");
      const duplicateIdempotency = isDuplicate && violation.includes("idempotency");
      if (duplicateIdempotency) {
        const existing = await db.conversationMessage.findFirst({
          where: { sessionId: session.sessionId, idempotencyKey: parsed.idempotencyKey },
        });
        if (existing) {
          return { message: toMessageSummary(existing), created: false };
        }
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
      throw error;
    }
  }
  throw new InterviewError("invalid_state", "The response could not be ordered. Try again.");
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
