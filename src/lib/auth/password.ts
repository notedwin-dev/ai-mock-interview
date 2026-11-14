import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing via Argon2id (docs/adr/0006-password-hashing.md, ADR-021).
 *
 * The library's defaults are used unchanged: they match the OWASP password
 * storage recommendation (Argon2id, m=19456 KiB, t=2, p=1) and ship as
 * prebuilt native binaries, so no node-gyp toolchain is required.
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return verify(passwordHash, password);
}
