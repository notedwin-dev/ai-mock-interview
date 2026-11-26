import { z } from "zod";
import {
  Prisma,
  type ConversationMessage,
  type InterviewCategory,
  type InterviewSession,
} from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ProviderConfigError, resolveForOutboundCall } from "@/lib/providers/config";
import {
  createInvitationToken,
  hashInvitationToken,
  invitationPath,
} from "./invitation-token";
import type { RoomStore } from "./room";
import { findActiveSessionByToken, issueInvitation, type IssuedInvitation } from "./invitations";
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
  capability: "llm";
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

async function loadRouteSnapshot(userId: string): Promise<ProviderRouteSnapshot> {
  try {
    // The interviewer/question-generation capability (FR-INTERVIEW-002) —
    // resolved at creation so a session always knows which route it was
    // built against; the decrypted key never leaves resolveForOutboundCall.
    const route = await resolveForOutboundCall(userId, "llm");
    return {
      capability: "llm",
      providerName: route.providerName,
      providerType: route.providerType,
      baseUrl: route.baseUrl,
      modelId: route.modelId,
    };
  } catch (error) {
    if (error instanceof ProviderConfigError && error.code === "not_found") {
      throw new InterviewError(
        "provider_route_missing",
        "Configure a provider with an LLM capability before starting an interview.",
      );
    }
    throw error;
  }
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
  const key = idempotencyKey?.trim() || null;
  if (key && (key.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(key))) {
    throw new InterviewError("invalid_input", "Invalid creation idempotency key.");
  }
  if (key) {
    const existing = await db.interviewSession.findFirst({
      where: { userId, creationIdempotencyKey: key },
    });
    if (existing) {
      const reissued = await issueInvitation(userId, existing.sessionId);
      return {
        ...toSessionSummary(existing, existing.providerRouteSnapshot as unknown as ProviderRouteSnapshot),
        invitation: reissued,
      };
    }
  }

  const category: InterviewCategory | null = await db.interviewCategory.findUnique({
    where: { categoryId: parsed.categoryId },
  });
  if (!category || !category.isActive) {
    throw new InterviewError("invalid_input", "Select an active interview category.");
  }

  const providerRouteSnapshot = await loadRouteSnapshot(userId);

  // FR-SETUP-007/008: the interview is born scheduled/ready, with a
  // revocable link whose raw capability is never stored (only its hash).
  const invitationToken = createInvitationToken();
  const session = await db.interviewSession.create({
    data: {
      userId,
      jobRole: parsed.jobRole,
      jobDescription: parsed.jobDescription ?? null,
      categoryId: category.categoryId,
      categoryCodeSnapshot: category.categoryCode,
      categoryNameSnapshot: category.categoryName,
      evaluationMode: parsed.evaluationMode,
      runtimeMode: parsed.runtimeMode,
      providerRouteSnapshot:
        providerRouteSnapshot as unknown as Prisma.InputJsonValue,
      interviewerPromptVersion: INTERVIEWER_PROMPT_VERSION,
      status: "scheduled",
      invitationTokenHash: hashInvitationToken(invitationToken),
      creationIdempotencyKey: key,
    },
  });
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
): Promise<{ message: ConversationMessage; created: boolean }> {
  if (data.idempotencyKey) {
    const existing = await db.conversationMessage.findFirst({
      where: { sessionId, idempotencyKey: data.idempotencyKey },
    });
    if (existing) return { message: existing, created: false };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const aggregate = await db.conversationMessage.aggregate({
        where: { sessionId },
        _max: { sequenceNumber: true },
      });
      const message = await db.conversationMessage.create({
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

  const result = await appendMessage(session.sessionId, {
    speakerType: "candidate",
    messageKind: "candidate_response",
    contentText: parsed.contentText,
    candidateInputMode: parsed.inputMode,
    idempotencyKey: parsed.idempotencyKey ?? null,
  });
  return { message: toMessageSummary(result.message), created: result.created };
}

/**
 * Persistence for the token-scoped room (FR-INTERVIEW-004), sharing
 * appendMessage with the typed path. The token is resolved to the owning
 * session by invitations.findActiveSessionByToken — no account session.
 */
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
        evaluationMode: session.evaluationMode,
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
      const result = await appendMessage(sessionId, {
        speakerType: "candidate",
        messageKind: "candidate_response",
        contentText,
        idempotencyKey: idempotencyKey ?? null,
        assessmentUnitId,
      });
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
        const unit = await db.interviewAssessmentUnit.create({
          data: { sessionId, unitNumber },
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

    async complete(sessionId) {
      await db.interviewSession.update({
        where: { sessionId },
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
