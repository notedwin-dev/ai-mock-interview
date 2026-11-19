import { describe, expect, it } from "vitest";
import { createInvitationToken, hashInvitationToken } from "./invitation-token";

/**
 * Hermetic tests for invitation-link secrets (FR-SETUP-008). Tokens must be
 * unguessable and the value stored in the database must never be the raw
 * capability carried by the link.
 */
describe("invitation tokens", () => {
  it("generates unguessable URL-safe tokens", () => {
    const tokens = Array.from({ length: 100 }, () => createInvitationToken());
    expect(new Set(tokens).size).toBe(100);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    }
  });

  it("stores a stable one-way hash, never the raw token", () => {
    const token = createInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashInvitationToken(token));
    expect(hash).not.toContain(token);
    expect(hash).not.toBe(hashInvitationToken(createInvitationToken()));
  });
});
