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
  categoryNameSnapshot: string;
  evaluationMode: string;
  /** The one runtime this session runs (ADR-006): exactly one room UI is shown. */
  runtimeMode: string;
  status: string;
}

function parseSessionId(sessionId: string): string {
  const parsed = z.uuid().safeParse(sessionId);
  if (!parsed.success) throw new InvitationError("not_found", "Interview not found.");
  return parsed.data;
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
  await db.interviewSession.update({
    where: { sessionId: session.sessionId },
    data: {
      invitationTokenHash: hashInvitationToken(token),
      invitationRevokedAt: null,
      status: "scheduled",
    },
  });
  return { token, path: invitationPath(token) };
}

/** Resolves a link to one interview's confirmation details — no auth, no privileges. */
export async function resolveInvitation(token: string): Promise<InvitationView | null> {
  if (!isInvitationToken(token)) return null;
  const session = await db.interviewSession.findFirst({
    where: {
      invitationTokenHash: hashInvitationToken(token),
      invitationRevokedAt: null,
    },
    select: {
      sessionId: true,
      jobRole: true,
      jobDescription: true,
      categoryNameSnapshot: true,
      evaluationMode: true,
      runtimeMode: true,
      status: true,
    },
  });
  return session ?? null;
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
