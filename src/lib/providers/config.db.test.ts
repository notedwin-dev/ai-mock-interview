import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import {
  createProviderConfiguration,
  deleteProviderConfiguration,
  listProviderConfigurations,
  resolveForOutboundCall,
  updateProviderConfiguration,
} from "./config";

/**
 * Integration tests for the provider configuration service against the
 * dedicated TEST_DATABASE_URL database (see docs/TESTING.md). The whole suite
 * is skipped when the variable is unset, so the default `pnpm test` stays
 * hermetic. Hooks live inside the gated describe so nothing runs — and
 * nothing connects — when the database is not provided.
 *
 * The database must be disposable: the suite truncates the tables it touches
 * before and after each test (never a dev/prod database).
 */

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const d = describe.skipIf(!TEST_DATABASE_URL);

const TABLES = [`"user_account"`, `"user_provider_configuration"`];

let db: PrismaClient;

d("provider configuration service (integration)", () => {
  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }) });
    // The service parses the master key lazily per call, so setting a
    // test-scoped key here is sufficient and never depends on real .env secrets.
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "vtest";
  });

  afterAll(async () => {
    await db.$disconnect();
    delete process.env["PROVIDER_ENCRYPTION_MASTER_KEY"];
    delete process.env["PROVIDER_ENCRYPTION_KEY_VERSION"];
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
  });

  afterEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
  });

  let userSeq = 0;
  async function createUser(): Promise<string> {
    const account = await db.userAccount.create({
      data: {
        email: `provider-config-${Date.now().toString(36)}-${++userSeq}@example.com`,
        passwordHash: "argon2id-test-hash",
        accountRole: "candidate",
      },
    });
    return account.userId;
  }

  const customInput = {
    providerType: "custom",
    providerName: "my-endpoint",
    baseUrl: "  https://API.Example.COM/v1  ",
    apiKey: "sk-plaintext-secret",
    capabilities: { llm: { modelId: "gpt-4o" } },
  };

  const presetInput = {
    providerType: "preset",
    providerName: "openai",
    apiKey: "sk-openai-key",
    capabilities: { asr: { modelId: "whisper-1" }, llm: { modelId: "gpt-4o" } },
  };

  it("creates a custom configuration with normalised Base URL and encrypted key", async () => {
    const userId = await createUser();
    const summary = await createProviderConfiguration(userId, customInput);

    expect(summary.providerType).toBe("custom");
    expect(summary.baseUrl).toBe("https://api.example.com/v1");
    expect(summary.credentialStatus).toBe("unvalidated");
    expect(summary.isEnabled).toBe(true);
    expect(summary.configurationVersion).toBe(1);

    const row = await db.userProviderConfiguration.findFirst({
      where: { userId, providerName: "my-endpoint" },
    });
    expect(row).not.toBeNull();
    const envelope = new TextDecoder().decode(row!.encryptedApiKey!);
    expect(envelope).not.toContain("sk-plaintext-secret");
    expect(envelope).toMatch(/^vvtest:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(row!.encryptionKeyVersion).toBe("vtest");
  });

  it("creates a preset configuration without a Base URL (registry supplies it)", async () => {
    const userId = await createUser();
    const summary = await createProviderConfiguration(userId, presetInput);
    expect(summary.baseUrl).toBeNull();
    expect(Object.keys(summary.capabilities).sort()).toEqual(["asr", "llm"]);
  });

  it("rejects a duplicate (user, providerName) pair", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);
    await expect(
      createProviderConfiguration(userId, { ...customInput, apiKey: "sk-other" }),
    ).rejects.toMatchObject({ code: "config_exists" });
  });

  it("rejects a preset used for a capability it does not declare", async () => {
    const userId = await createUser();
    await expect(
      createProviderConfiguration(userId, {
        providerType: "preset",
        providerName: "openai",
        apiKey: "sk-x",
        capabilities: { tts: { modelId: "tts-1" } },
      }),
    ).rejects.toMatchObject({ code: "capability_not_supported" });
  });

  it("rejects unknown presets, reserved custom names and missing credentials/URL", async () => {
    const userId = await createUser();
    await expect(
      createProviderConfiguration(userId, {
        providerType: "preset",
        providerName: "does-not-exist",
        apiKey: "sk-x",
        capabilities: { llm: { modelId: "x" } },
      }),
    ).rejects.toMatchObject({ code: "unknown_preset" });

    await expect(
      createProviderConfiguration(userId, {
        providerType: "custom",
        providerName: "openai",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-x",
        capabilities: { llm: { modelId: "x" } },
      }),
    ).rejects.toMatchObject({ code: "reserved_preset_name" });

    await expect(
      createProviderConfiguration(userId, {
        providerType: "custom",
        providerName: "my-endpoint",
        baseUrl: "https://api.example.com/v1",
        capabilities: { llm: { modelId: "x" } },
      }),
    ).rejects.toMatchObject({ code: "missing_credential" });

    await expect(
      createProviderConfiguration(userId, {
        providerType: "custom",
        providerName: "my-endpoint",
        apiKey: "sk-x",
        capabilities: { llm: { modelId: "x" } },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      createProviderConfiguration(userId, {
        providerType: "preset",
        providerName: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-x",
        capabilities: { llm: { modelId: "x" } },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("never exposes credential material in summaries (write-only invariant)", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);

    const list = await listProviderConfigurations(userId);
    expect(list).toHaveLength(1);
    for (const summary of list) {
      const serialised = JSON.stringify(summary);
      expect(serialised).not.toContain("sk-plaintext-secret");
      expect(serialised).not.toContain("encryptedApiKey");
      expect(serialised).not.toContain("encryptionKeyVersion");
      expect(Object.hasOwn(summary, "encryptedApiKey")).toBe(false);
    }
  });

  it("updates capabilities without the key: envelope bytes stay identical, status resets", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, presetInput);

    const before = await db.userProviderConfiguration.findFirst({
      where: { userId, providerName: "openai" },
    });
    const bytesBefore = Buffer.from(before!.encryptedApiKey!).toString("base64");

    const updated = await updateProviderConfiguration(userId, "openai", {
      capabilities: { llm: { modelId: "gpt-4o-mini" } },
    });

    expect(updated.credentialStatus).toBe("unvalidated");
    expect(updated.configurationVersion).toBe(2);
    expect(Object.keys(updated.capabilities)).toEqual(["llm"]);

    const after = await db.userProviderConfiguration.findFirst({
      where: { userId, providerName: "openai" },
    });
    expect(Buffer.from(after!.encryptedApiKey!).toString("base64")).toBe(bytesBefore);
    expect(after!.encryptionKeyVersion).toBe("vtest");
  });

  it("re-encrypts on key change and resets the credential status", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);

    const before = await db.userProviderConfiguration.findFirst({
      where: { userId, providerName: "my-endpoint" },
    });
    const bytesBefore = Buffer.from(before!.encryptedApiKey!).toString("base64");

    const updated = await updateProviderConfiguration(userId, "my-endpoint", {
      apiKey: "sk-replaced-key",
    });
    expect(updated.credentialStatus).toBe("unvalidated");
    expect(updated.configurationVersion).toBe(2);

    const after = await db.userProviderConfiguration.findFirst({
      where: { userId, providerName: "my-endpoint" },
    });
    expect(Buffer.from(after!.encryptedApiKey!).toString("base64")).not.toBe(bytesBefore);
  });

  it("an isEnabled toggle alone never invalidates the credential", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);

    await db.userProviderConfiguration.updateMany({
      where: { userId, providerName: "my-endpoint" },
      data: { credentialStatus: "valid" },
    });

    const updated = await updateProviderConfiguration(userId, "my-endpoint", {
      isEnabled: false,
    });
    expect(updated.isEnabled).toBe(false);
    expect(updated.credentialStatus).toBe("valid");
    expect(updated.configurationVersion).toBe(2);
  });

  it("resolves an enabled configuration for an outbound call and decrypts it", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);

    const resolved = await resolveForOutboundCall(userId, "llm");
    expect(resolved.providerName).toBe("my-endpoint");
    expect(resolved.providerType).toBe("custom");
    expect(resolved.baseUrl).toBe("https://api.example.com/v1");
    expect(resolved.modelId).toBe("gpt-4o");
    expect(resolved.apiKey).toBe("sk-plaintext-secret");
  });

  it("refuses to re-enable a configuration whose probe marked it invalid", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);

    // Simulate the persisted post-probe state after a failed capability test:
    // the probe stores "invalid" AND disables the row (FR-PROVIDER-006 —
    // a failed test prevents the capability being or remaining enabled).
    const row = await db.userProviderConfiguration.findFirstOrThrow({
      where: { userId, providerName: "my-endpoint" },
    });
    await db.userProviderConfiguration.update({
      where: { userProviderConfigurationId: row.userProviderConfigurationId },
      data: { credentialStatus: "invalid", isEnabled: false },
    });

    await expect(updateProviderConfiguration(userId, "my-endpoint", { isEnabled: true })).rejects
      .toMatchObject({ code: "probe_failed" });
    expect((await listProviderConfigurations(userId))[0]?.isEnabled).toBe(false);
  });

  it("allows re-enabling in the same patch that fixes the credential", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);
    const row = await db.userProviderConfiguration.findFirstOrThrow({
      where: { userId, providerName: "my-endpoint" },
    });
    await db.userProviderConfiguration.update({
      where: { userProviderConfigurationId: row.userProviderConfigurationId },
      data: { credentialStatus: "invalid", isEnabled: false },
    });

    // A re-saved key is a material change: the status resets to unvalidated,
    // so the failed probe must no longer block enabling.
    const updated = await updateProviderConfiguration(userId, "my-endpoint", {
      apiKey: "sk-fixed-key",
      isEnabled: true,
    });
    expect(updated.isEnabled).toBe(true);
    expect(updated.credentialStatus).toBe("unvalidated");
  });

  it("resolves preset Base URLs from the registry at call time", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, presetInput);

    const resolved = await resolveForOutboundCall(userId, "asr");
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.modelId).toBe("whisper-1");
    expect(resolved.apiKey).toBe("sk-openai-key");
  });

  it("resolves the scorer capability from a configuration (FR-PROVIDER-003)", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, {
      ...presetInput,
      capabilities: {
        llm: { modelId: "gpt-4o" },
        scorer: { modelId: "gpt-4o-mini" },
      },
    });

    const resolved = await resolveForOutboundCall(userId, "scorer");
    expect(resolved.modelId).toBe("gpt-4o-mini");
    expect(resolved.apiKey).toBe("sk-openai-key");
  });

  it("fails closed when no enabled configuration serves the capability", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);

    // tts is not configured on this row
    await expect(resolveForOutboundCall(userId, "tts")).rejects.toMatchObject({
      code: "not_found",
    });

    // a disabled row must not resolve
    await updateProviderConfiguration(userId, "my-endpoint", { isEnabled: false });
    await expect(resolveForOutboundCall(userId, "llm")).rejects.toMatchObject({
      code: "not_found",
    });

    // an unknown user has nothing
    await expect(resolveForOutboundCall(randomUUID(), "llm")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("resolves the oldest enabled configuration when several serve one capability", async () => {
    const userId = await createUser();
    await createProviderConfiguration(userId, customInput);
    await createProviderConfiguration(userId, {
      ...customInput,
      providerName: "newer-endpoint",
    });

    const resolved = await resolveForOutboundCall(userId, "llm");
    expect(resolved.providerName).toBe("my-endpoint");
  });

  it("ownership is scoped to the calling user", async () => {
    const owner = await createUser();
    const outsider = await createUser();
    await createProviderConfiguration(owner, customInput);

    const list = await listProviderConfigurations(outsider);
    expect(list).toHaveLength(0);

    await expect(
      updateProviderConfiguration(outsider, "my-endpoint", { isEnabled: false }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deleteProviderConfiguration(outsider, "my-endpoint"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("deletes an owned configuration and destroys the stored credential", async () => {
    const owner = await createUser();
    await createProviderConfiguration(owner, customInput);

    await deleteProviderConfiguration(owner, "my-endpoint");
    const row = await db.userProviderConfiguration.findFirst({
      where: { userId: owner, providerName: "my-endpoint" },
    });
    expect(row).toBeNull();

    await expect(deleteProviderConfiguration(owner, "my-endpoint")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("wraps non-Error zod failures as invalid_input", async () => {
    const userId = await createUser();
    await expect(
      createProviderConfiguration(userId, null),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
