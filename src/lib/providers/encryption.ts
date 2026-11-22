import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getProviderEncryptionEnv, isValidKeyVersion, type ProviderEncryptionEnv } from "./env";

/**
 * AES-256-GCM envelope encryption for user-supplied (BYOK) provider API keys
 * (docs/adr/0005-provider-credential-encryption.md).
 *
 * Envelope format: `v<version>:<iv>:<tag>:<ciphertext>` — every segment after
 * the version prefix is base64; the IV is a fresh 12-byte value per
 * encryption and the 16-byte auth tag is stored alongside the ciphertext.
 *
 * The master key lives outside the database; plaintext keys are never
 * cached, logged or returned to a client — decryption happens immediately
 * before an outbound server call in the provider configuration service.
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface EncryptedSecret {
  /** `v<version>:iv:tag:ciphertext`, stored in encrypted_api_key. */
  envelope: string;
  /** Same version, stored in encryption_key_version (DB CHECK pairs them). */
  encryptionKeyVersion: string;
}

export type ProviderCryptoErrorCode =
  | "malformed_envelope"
  | "unknown_key_version"
  | "decrypt_failed";

export class ProviderCryptoError extends Error {
  readonly code: ProviderCryptoErrorCode;

  constructor(code: ProviderCryptoErrorCode, message: string) {
    super(message);
    this.name = "ProviderCryptoError";
    this.code = code;
  }
}

function encryptWithKey(key: Uint8Array, version: string, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v${version}:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function encryptApiKey(
  plaintext: string,
  env: ProviderEncryptionEnv = getProviderEncryptionEnv(),
): EncryptedSecret {
  return {
    envelope: encryptWithKey(env.activeKey, env.activeKeyVersion, plaintext),
    encryptionKeyVersion: env.activeKeyVersion,
  };
}

function parseEnvelope(envelope: string): {
  version: string;
  iv: Uint8Array;
  tag: Uint8Array;
  ciphertext: Uint8Array;
} {
  const segments = envelope.split(":");
  if (
    segments.length !== 4 ||
    !segments[0].startsWith("v") ||
    !isValidKeyVersion(segments[0].slice(1))
  ) {
    throw new ProviderCryptoError(
      "malformed_envelope",
      "Provider credential envelope is malformed",
    );
  }
  try {
    const iv = Buffer.from(segments[1]!, "base64");
    const tag = Buffer.from(segments[2]!, "base64");
    const ciphertext = Buffer.from(segments[3]!, "base64");
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
      throw new Error("invalid segment lengths");
    }
    return {
      version: segments[0].slice(1),
      iv: new Uint8Array(iv),
      tag: new Uint8Array(tag),
      ciphertext: new Uint8Array(ciphertext),
    };
  } catch {
    throw new ProviderCryptoError(
      "malformed_envelope",
      "Provider credential envelope is malformed",
    );
  }
}

export function decryptApiKey(
  envelope: string,
  env: ProviderEncryptionEnv = getProviderEncryptionEnv(),
): string {
  const { version, iv, tag, ciphertext } = parseEnvelope(envelope);

  const key = env.keysByVersion.get(version);
  if (!key) {
    // Fail closed: an unknown key version means the master key was rotated
    // without keeping the old one available, and the credential is lost.
    throw new ProviderCryptoError(
      "unknown_key_version",
      `No decryption key is available for credential key version "${version}"`,
    );
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Auth-tag failure (tampered or wrong key) — never return partial data.
    throw new ProviderCryptoError(
      "decrypt_failed",
      "Provider credential failed integrity verification",
    );
  }
}
