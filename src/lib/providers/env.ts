/**
 * Feature-scoped environment for BYOK provider-credential encryption
 * (docs/adr/0005-provider-credential-encryption.md). Like getAuthEnv, parsed
 * lazily on first use so builds and tests never require these secrets.
 *
 * Rotation (ADR-0005): a new master key ships with a new key version; the old
 * key stays available via PROVIDER_ENCRYPTION_LEGACY_KEYS until no stored row
 * references its version any more.
 */

/** One key per version: the same version must always mean the same key. */
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,30}$/;

function decodeBase64Key(value: string): Uint8Array | null {
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== 32) return null;
  // Buffer.from is lenient; require the canonical round-trip so garbage,
  // whitespace and non-canonical padding are rejected.
  if (buffer.toString("base64") !== value) return null;
  return new Uint8Array(buffer);
}

export interface ProviderEncryptionEnv {
  /** Version written to new rows (PROVIDER_ENCRYPTION_KEY_VERSION). */
  activeKeyVersion: string;
  /** Decodes to exactly 32 bytes (AES-256). */
  activeKey: Uint8Array;
  /** Active key plus any legacy keys, keyed by their version. */
  keysByVersion: ReadonlyMap<string, Uint8Array>;
}

export function getProviderEncryptionEnv(): ProviderEncryptionEnv {
  const masterKeyBase64 = process.env["PROVIDER_ENCRYPTION_MASTER_KEY"]?.trim();
  const activeKeyVersion = process.env["PROVIDER_ENCRYPTION_KEY_VERSION"]?.trim();

  const activeKey = masterKeyBase64 ? decodeBase64Key(masterKeyBase64) : null;
  if (!activeKey) {
    throw new Error(
      "PROVIDER_ENCRYPTION_MASTER_KEY must be a base64-encoded 32-byte key (generate with: openssl rand -base64 32)",
    );
  }
  if (!activeKeyVersion || !KEY_VERSION_PATTERN.test(activeKeyVersion)) {
    throw new Error(
      "PROVIDER_ENCRYPTION_KEY_VERSION must be 1-30 characters of [A-Za-z0-9._-] (e.g. v1 or 2026-11)",
    );
  }

  const keysByVersion = new Map<string, Uint8Array>([
    [activeKeyVersion, activeKey],
  ]);

  const legacyRaw = process.env["PROVIDER_ENCRYPTION_LEGACY_KEYS"]?.trim();
  if (legacyRaw) {
    for (const pair of legacyRaw.split(",")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const separatorIndex = trimmed.indexOf("=");
      const version = separatorIndex === -1 ? "" : trimmed.slice(0, separatorIndex).trim();
      const keyBase64 = separatorIndex === -1 ? "" : trimmed.slice(separatorIndex + 1).trim();
      if (!KEY_VERSION_PATTERN.test(version)) {
        throw new Error(
          "PROVIDER_ENCRYPTION_LEGACY_KEYS entries must look like <version>=<base64 32-byte key> with a valid version",
        );
      }
      const legacyKey = decodeBase64Key(keyBase64);
      if (!legacyKey) {
        throw new Error(
          `PROVIDER_ENCRYPTION_LEGACY_KEYS key for version "${version}" must be a base64-encoded 32-byte key`,
        );
      }
      if (keysByVersion.has(version)) {
        throw new Error(
          `PROVIDER_ENCRYPTION_LEGACY_KEYS declares version "${version}" twice (or it collides with the active version)`,
        );
      }
      keysByVersion.set(version, legacyKey);
    }
  }

  return { activeKeyVersion, activeKey, keysByVersion };
}

/** Machine-readable version pattern shared with the envelope parser. */
export function isValidKeyVersion(version: string): boolean {
  return KEY_VERSION_PATTERN.test(version);
}
