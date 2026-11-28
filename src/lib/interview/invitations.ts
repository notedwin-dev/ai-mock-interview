import { z } from "zod";
import { db } from "@/lib/db";
import {
  createInvitationToken,
  hashInvitationToken,
  invitationPath,
  isInvitationToken,
} from "./invitation-token";

/**
 * Revocable invitation links (TT-21; FR-SETUP-008). The raw capability travels
 * only in the shared link; the database stores a SHA-256 hash. Resolution is
 * token-scoped: it returns the minimum confirmation details for ONE interview
 * and grants no account privileges and no access to any other interview.
 */
export type InvitationErrorCode = "not_found" | "invalid_state";

export class InvitationError extends Error {
  readonly code: InvitationErrorCode;

  constructor(code: InvitationErrorCode, message: string) {
    super(message);
    this.name = "InvitationError";
    this.code = code;
  }
}

export interface IssuedInvitation {
  token: string;
  path: string;
}

export interface InvitationView {
  sessionId: string;
  jobRole: string;
  jobDescription: string | null;
  experienceLevel: string | null;
  techStack: string[];
  questionCount: number | null;
  categoryNameSnapshot: string;
  evaluationMode: string;
  /** The one runtime this session runs (ADR-006): exactly one room UI is shown. */
  runtimeMode: string;
  status: string;
  scheduledAt: Date | null;
}

/** Shape of a raw invitation capability: 32 bytes of base64url (43 chars). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function parseSessionId(sessionId: string): string {
  const parsed = z.uuid().safeParse(sessionId);
  if (!parsed.success) throw new InvitationError("not_found", "Interview not found.");
  return parsed.data;
}

/**
 * Resolves a raw token to the one active (non-revoked) session it grants, or
 * null. The single token→session lookup shared by the confirmation view and
 * the room store: malformed tokens never reach the database. Selects the
 * superset both consumers need; each maps out what it uses.
 */
export async function findActiveSessionByToken(
  token: string,
): Promise<{
  sessionId: string;
  userId: string;
  jobRole: string;
  jobDescription: string | null;
  experienceLevel: string | null;
  techStack: unknown;
  questionCount: number | null;
  categoryNameSnapshot: string;
  evaluationMode: string;
  runtimeMode: string;
  status: string;
  scheduledAt: Date | null;
} | null> {
  // Shared validator from the runtime batch; TOKEN_PATTERN stays exported for
  // callers that still describe the raw shape. Malformed tokens never hit the DB.
  if (!isInvitationToken(token)) return null;
  return db.interviewSession.findFirst({
    where: {
      invitationTokenHash: hashInvitationToken(token),
      invitationRevokedAt: null,
    },
    select: {
      sessionId: true,
      userId: true,
      jobRole: true,
      jobDescription: true,
      experienceLevel: true,
      techStack: true,
      questionCount: true,
      categoryNameSnapshot: true,
      evaluationMode: true,
      runtimeMode: true,
      status: true,
      scheduledAt: true,
    },
  });
}

async function loadOwned(userId: string, sessionId: string) {
  const session = await db.interviewSession.findFirst({
    where: { sessionId: parseSessionId(sessionId), userId },
    select: { sessionId: true, status: true },
  });
  if (!session) throw new InvitationError("not_found", "Interview not found.");
  return session;
}

/** Issues (or replaces) the link and moves the interview to scheduled/ready. */
export async function issueInvitation(
  userId: string,
  sessionId: string,
): Promise<IssuedInvitation> {
  const session = await loadOwned(userId, sessionId);
  if (session.status === "active" || session.status === "completed") {
    throw new InvitationError("invalid_state", "A running or completed interview has no invitation link.");
  }
  const token = createInvitationToken();
  // The permitted-status predicate is repeated in the atomic update: an
  // intervening lifecycle transition (the interview was started or completed
  // after the read) must not be overwritten back to scheduled. Reissue stays
  // permitted for every non-running status, as the guard above allows.
  const updated = await db.interviewSession.updateMany({
    where: {
      sessionId: session.sessionId,
      status: { notIn: ["active", "completed"] },
    },
    data: {
      invitationTokenHash: hashInvitationToken(token),
      invitationRevokedAt: null,
      status: "scheduled",
    },
  });
  if (updated.count === 0) {
    throw new InvitationError("invalid_state", "A running or completed interview has no invitation link.");
  }
  return { token, path: invitationPath(token) };
}

/** Resolves a link to one interview's confirmation details — no auth, no privileges. */
export async function resolveInvitation(token: string): Promise<InvitationView | null> {
  // One token→session lookup shared with the room store. The owner's user id
  // is deliberately omitted: the link grants interview-only access.
  const session = await findActiveSessionByToken(token);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    jobRole: session.jobRole,
    jobDescription: session.jobDescription,
    experienceLevel: session.experienceLevel,
    techStack: Array.isArray(session.techStack)
      ? session.techStack.filter((value): value is string => typeof value === "string")
      : [],
    questionCount: session.questionCount,
    categoryNameSnapshot: session.categoryNameSnapshot,
    evaluationMode: session.evaluationMode,
    runtimeMode: session.runtimeMode,
    status: session.status,
    scheduledAt: session.scheduledAt,
  };
}

/** Invalidates the link. Safe to call twice. */
export async function revokeInvitation(userId: string, sessionId: string): Promise<void> {
  const session = await loadOwned(userId, sessionId);
  await db.interviewSession.update({
    where: { sessionId: session.sessionId },
    data: { invitationTokenHash: null, invitationRevokedAt: new Date() },
  });
}

export interface EndedInterview {
  status: string;
  completedAt: string | null;
  /** True when the interview was already completed before this request. */
  alreadyEnded: boolean;
}

/**
 * Ends the interview behind an invitation link (FR-INTERVIEW-011). The link is
 * the only capability: no account session is involved and nothing but this
 * interview's completion state is returned.
 *
 * Repeat requests are idempotent — a completed interview returns its existing
 * state instead of creating a second completion event. An interview that never
 * started is rejected, mirroring the DB rule that `completed_at` implies
 * `started_at`.
 */
export async function endInvitationInterview(token: string): Promise<EndedInterview> {
  const session = await resolveInvitation(token);
  if (!session) {
    throw new InvitationError("not_found", "This invitation link is not available.");
  }

  const ended = await db.interviewSession.updateMany({
    where: { sessionId: session.sessionId, status: "active" },
    data: { status: "completed", completedAt: new Date() },
  });
  const current = await db.interviewSession.findUniqueOrThrow({
    where: { sessionId: session.sessionId },
    select: { sessionId: true, status: true, completedAt: true },
  });
  if (ended.count === 0 && current.status !== "completed") {
    throw new InvitationError("invalid_state", "This interview is not running.");
  }
  return {
    status: current.status,
    completedAt: current.completedAt?.toISOString() ?? null,
    alreadyEnded: ended.count === 0,
  };
}
