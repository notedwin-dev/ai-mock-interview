import { createHash, randomBytes } from "node:crypto";

/**
 * Invitation-link secrets (FR-SETUP-008). The raw token is a 32-byte
 * base64url capability shared only through the link; the database stores a
 * SHA-256 hash, so a database leak alone cannot grant interview access.
 */
const TOKEN_BYTES = 32;

export function createInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The link path handed to the owner — a real route, never a made-up URL. */
export function invitationPath(token: string): string {
  return `/i/${token}`;
}
