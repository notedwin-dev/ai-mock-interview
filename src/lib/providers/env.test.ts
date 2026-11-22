import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getProviderEncryptionEnv } from "./env";

const key32 = () => randomBytes(32).toString("base64");

afterEach(() => {
  delete process.env["PROVIDER_ENCRYPTION_MASTER_KEY"];
  delete process.env["PROVIDER_ENCRYPTION_KEY_VERSION"];
  delete process.env["PROVIDER_ENCRYPTION_LEGACY_KEYS"];
});

describe("getProviderEncryptionEnv", () => {
  it("parses the active key and version", () => {
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = key32();
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "v1";
    const env = getProviderEncryptionEnv();
    expect(env.activeKeyVersion).toBe("v1");
    expect(env.activeKey).toBeInstanceOf(Uint8Array);
    expect(env.activeKey.byteLength).toBe(32);
    expect(env.keysByVersion.get("v1")).toBe(env.activeKey);
  });

  it("fails fast when the master key is missing", () => {
    expect(() => getProviderEncryptionEnv()).toThrow(
      /PROVIDER_ENCRYPTION_MASTER_KEY/,
    );
  });

  it("fails fast when the master key is not exactly 32 bytes", () => {
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = randomBytes(16).toString("base64");
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "v1";
    expect(() => getProviderEncryptionEnv()).toThrow(
      /PROVIDER_ENCRYPTION_MASTER_KEY/,
    );
  });

  it("fails fast when the master key is not canonical base64", () => {
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = "not base64 at all !!";
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "v1";
    expect(() => getProviderEncryptionEnv()).toThrow(
      /PROVIDER_ENCRYPTION_MASTER_KEY/,
    );
  });

  it("fails fast when the version is missing or has invalid characters", () => {
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = key32();
    expect(() => getProviderEncryptionEnv()).toThrow(/KEY_VERSION/);
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "bad version!";
    expect(() => getProviderEncryptionEnv()).toThrow(/KEY_VERSION/);
  });

  it("accepts legacy keys under distinct versions", () => {
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = key32();
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "v2";
    process.env["PROVIDER_ENCRYPTION_LEGACY_KEYS"] = `v1=${key32()}`;
    const env = getProviderEncryptionEnv();
    expect(env.keysByVersion.size).toBe(2);
    expect(env.keysByVersion.has("v1")).toBe(true);
    expect(env.keysByVersion.has("v2")).toBe(true);
  });

  it("rejects a legacy entry with an unusable key", () => {
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = key32();
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "v2";
    process.env["PROVIDER_ENCRYPTION_LEGACY_KEYS"] = "v1=tooshort";
    expect(() => getProviderEncryptionEnv()).toThrow(/LEGACY_KEYS/);
  });

  it("rejects a legacy version that collides with the active version", () => {
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = key32();
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "v1";
    process.env["PROVIDER_ENCRYPTION_LEGACY_KEYS"] = `v1=${key32()}`;
    expect(() => getProviderEncryptionEnv()).toThrow(/twice/);
  });
});
