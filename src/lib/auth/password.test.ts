import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

// Argon2id via @node-rs/argon2 — docs/adr/0006-password-hashing.md (ADR-021).
describe("password hashing (ADR-0006)", () => {
  const password = "correct-horse-battery-1";

  it("produces an Argon2id PHC-encoded hash", async () => {
    expect(await hashPassword(password)).toMatch(/^\$argon2id\$/);
  });

  it("verifies the correct password and rejects a wrong one", async () => {
    const passwordHash = await hashPassword(password);
    await expect(verifyPassword(passwordHash, password)).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, "wrong-password-2")).resolves.toBe(
      false,
    );
  });

  it("salts randomly, so identical passwords produce different hashes", async () => {
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    await expect(verifyPassword(second, password)).resolves.toBe(true);
  });

  it("rejects a tampered hash", async () => {
    const passwordHash = await hashPassword(password);
    // Corrupt the final base64 character of the digest, keeping the PHC
    // string structurally valid so verification runs against wrong bytes.
    const last = passwordHash.at(-1) ?? "A";
    const replacement = last === "A" ? "B" : "A";
    const tampered = passwordHash.slice(0, -1) + replacement;
    await expect(verifyPassword(tampered, password)).resolves.toBe(false);
  });
});
