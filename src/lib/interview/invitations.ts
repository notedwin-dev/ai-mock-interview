import { z } from "zod";
import { db } from "@/lib/db";
import { createInvitationToken, hashInvitationToken, invitationPath } from "./invitation-token";

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
  status: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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
  if (!TOKEN_PATTERN.test(token)) return null;
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
