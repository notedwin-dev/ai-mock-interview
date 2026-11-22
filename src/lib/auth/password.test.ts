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
    // Corrupt the first base64 character of the digest, keeping the PHC
    // string structurally valid so verification runs against wrong bytes.
    // The LAST character is not safe to tamper: in unpadded base64 it
    // carries canonical zero padding bits, so replacing it (e.g. A->B)
    // yields a non-canonical string the decoder rejects — observed flake.
    const segments = passwordHash.split("$");
    const digest = segments[5] ?? "";
    const first = digest[0] ?? "A";
    segments[5] = (first === "A" ? "B" : "A") + digest.slice(1);
    const tampered = segments.join("$");
    await expect(verifyPassword(tampered, password)).resolves.toBe(false);
  });
});
