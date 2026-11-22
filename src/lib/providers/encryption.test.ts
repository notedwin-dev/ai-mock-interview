import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ProviderCryptoError,
  decryptApiKey,
  encryptApiKey,
} from "./encryption";
import { getProviderEncryptionEnv } from "./env";

const activeKey = new Uint8Array(randomBytes(32));
const legacyKey = new Uint8Array(randomBytes(32));
const env = {
  activeKeyVersion: "v2",
  activeKey,
  keysByVersion: new Map<string, Uint8Array>([
    ["v2", activeKey],
    ["v1", legacyKey],
  ]),
};

describe("provider credential encryption (ADR-0005)", () => {
  it("round-trips a plaintext API key", () => {
    const { envelope, encryptionKeyVersion } = encryptApiKey("sk-test-secret", env);
    expect(encryptionKeyVersion).toBe("v2");
    expect(decryptApiKey(envelope, env)).toBe("sk-test-secret");
  });

  it("produces the v<version>:iv:tag:ciphertext envelope with correct segment sizes", () => {
    const { envelope } = encryptApiKey("sk-test-secret", env);
    const segments = envelope.split(":");
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe("vv2");
    expect(Buffer.from(segments[1]!, "base64")).toHaveLength(12);
    expect(Buffer.from(segments[2]!, "base64")).toHaveLength(16);
  });

  it("uses a fresh IV per encryption, so equal plaintexts never encrypt alike", () => {
    const first = encryptApiKey("same-key", env).envelope;
    const second = encryptApiKey("same-key", env).envelope;
    expect(first).not.toBe(second);
    expect(decryptApiKey(first, env)).toBe("same-key");
    expect(decryptApiKey(second, env)).toBe("same-key");
  });

  it("decrypts envelopes produced under a retained legacy key version", () => {
    const legacyEnvelope = encryptApiKey("legacy-key", {
      activeKeyVersion: "v1",
      activeKey: legacyKey,
      keysByVersion: new Map([["v1", legacyKey]]),
    }).envelope;
    expect(decryptApiKey(legacyEnvelope, env)).toBe("legacy-key");
  });

  it("fails closed on a tampered ciphertext (auth-tag failure)", () => {
    const { envelope } = encryptApiKey("sk-test-secret", env);
    const segments = envelope.split(":");
    const ciphertext = Buffer.from(segments[3]!, "base64");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    segments[3] = ciphertext.toString("base64");
    try {
      decryptApiKey(segments.join(":"), env);
      expect.unreachable("tampered ciphertext must not decrypt");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCryptoError);
      expect((error as ProviderCryptoError).code).toBe("decrypt_failed");
    }
  });

  it("fails closed on an envelope with an unknown key version", () => {
    const { envelope } = encryptApiKey("sk-test-secret", {
      activeKeyVersion: "v9",
      activeKey: new Uint8Array(randomBytes(32)),
      keysByVersion: new Map([["v9", new Uint8Array(randomBytes(32))]]),
    });
    try {
      decryptApiKey(envelope, env);
      expect.unreachable("unknown version must not decrypt");
    } catch (error) {
      expect((error as ProviderCryptoError).code).toBe("unknown_key_version");
    }
  });

  it("rejects malformed envelopes before touching any key", () => {
    for (const bad of ["", "v1:only:three", "no-prefix:aa:bb:cc", "v1:%%:bb:cc"]) {
      try {
        decryptApiKey(bad, env);
        expect.unreachable("malformed envelope must throw");
      } catch (error) {
        expect((error as ProviderCryptoError).code).toBe("malformed_envelope");
      }
    }
  });

  it("never leaks plaintext or key material in error messages", () => {
    const secret = "sk-super-secret-value";
    const { envelope } = encryptApiKey(secret, env);
    const segments = envelope.split(":");
    const ciphertext = Buffer.from(segments[3]!, "base64");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    segments[3] = ciphertext.toString("base64");
    try {
      decryptApiKey(segments.join(":"), env);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain(
        Buffer.from(activeKey).toString("base64"),
      );
    }
  });

  it("defaults to the lazily parsed process environment", () => {
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "vtest";
    try {
      const encrypted = encryptApiKey("env-backed");
      expect(encrypted.encryptionKeyVersion).toBe("vtest");
      expect(decryptApiKey(encrypted.envelope)).toBe("env-backed");
    } finally {
      delete process.env["PROVIDER_ENCRYPTION_MASTER_KEY"];
      delete process.env["PROVIDER_ENCRYPTION_KEY_VERSION"];
    }
  });
});

describe("getProviderEncryptionEnv integration with crypto", () => {
  it("parses a full rotation environment usable by decryptApiKey", () => {
    const legacy = randomBytes(32).toString("base64");
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "v2";
    process.env["PROVIDER_ENCRYPTION_LEGACY_KEYS"] = `v1=${legacy}`;
    try {
      const parsed = getProviderEncryptionEnv();
      const legacyEnvelope = encryptApiKey("from-v1", {
        activeKeyVersion: "v1",
        activeKey: new Uint8Array(Buffer.from(legacy, "base64")),
        keysByVersion: new Map([["v1", new Uint8Array(Buffer.from(legacy, "base64"))]]),
      }).envelope;
      expect(decryptApiKey(legacyEnvelope, parsed)).toBe("from-v1");
    } finally {
      delete process.env["PROVIDER_ENCRYPTION_MASTER_KEY"];
      delete process.env["PROVIDER_ENCRYPTION_KEY_VERSION"];
      delete process.env["PROVIDER_ENCRYPTION_LEGACY_KEYS"];
    }
  });
});
