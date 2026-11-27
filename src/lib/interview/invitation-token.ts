import { createHash, randomBytes } from "node:crypto";

/**
 * Invitation-link secrets (FR-SETUP-008). The raw token is a 32-byte
 * base64url capability shared only through the link; the database stores a
 * SHA-256 hash, so a database leak alone cannot grant interview access.
 */
const TOKEN_BYTES = 32;

/**
 * Shape of a raw token: 32 bytes of base64url. Shared by every token-scoped
 * entry point so a malformed link is rejected before it reaches the database.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isInvitationToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function createInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The link path handed to the owner — a real route, never a made-up URL. */
export function invitationPath(token: string): string {
  return `/interview/${token}`;
}
