import { describe, expect, it } from "vitest";
import {
  assertEnablementAllowed,
  capabilitiesJsonSchema,
  providerConfigInputSchema,
  ProviderConfigError,
  validateProviderRules,
  validateProviderTarget,
} from "./config";
import { ProviderCryptoError } from "./encryption";

describe("capabilitiesJsonSchema", () => {
  it("accepts a subset of capabilities (one row can serve asr+llm only)", () => {
    const parsed = capabilitiesJsonSchema.parse({
      asr: { modelId: "whisper-1" },
      llm: { modelId: "gpt-4o" },
    });
    expect(parsed.asr?.modelId).toBe("whisper-1");
    expect(parsed.llm?.modelId).toBe("gpt-4o");
  });

  it("preserves exact model_id casing (never normalised)", () => {
    expect(
      capabilitiesJsonSchema.parse({ llm: { modelId: "GPT-4o-Mini" } }).llm?.modelId,
    ).toBe("GPT-4o-Mini");
  });

  it("accepts the scorer capability (FR-PROVIDER-003) with its own model_id", () => {
    const parsed = capabilitiesJsonSchema.parse({
      llm: { modelId: "gpt-4o" },
      scorer: { modelId: "gpt-4o-mini" },
    });
    expect(parsed.scorer?.modelId).toBe("gpt-4o-mini");
  });

  it("accepts the realtime capability (register Option A) with its own model_id", () => {
    const parsed = capabilitiesJsonSchema.parse({
      llm: { modelId: "gpt-4o" },
      realtime: { modelId: "realtime-agent-model" },
    });
    expect(parsed.realtime?.modelId).toBe("realtime-agent-model");
  });

  it("rejects unknown capability keys", () => {
    expect(() =>
      capabilitiesJsonSchema.parse({ stt: { modelId: "whisper-1" } }),
    ).toThrow();
  });

  it("rejects blank or missing model_id", () => {
    expect(() => capabilitiesJsonSchema.parse({ llm: { modelId: "   " } })).toThrow();
    expect(() => capabilitiesJsonSchema.parse({ llm: {} })).toThrow();
  });

  it("rejects model_id beyond the 200-character limit", () => {
    expect(() =>
      capabilitiesJsonSchema.parse({ llm: { modelId: "m".repeat(201) } }),
    ).toThrow();
  });
});

describe("providerConfigInputSchema", () => {
  const base = {
    providerType: "custom",
    providerName: "my-endpoint",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    capabilities: { llm: { modelId: "gpt-4o" } },
  };

  it("rejects an empty capabilities map", () => {
    expect(() => providerConfigInputSchema.parse({ ...base, capabilities: {} })).toThrow();
  });

  it("rejects unknown fields (strict contract for API boundaries)", () => {
    expect(() => providerConfigInputSchema.parse({ ...base, voice: "x" })).toThrow();
  });

  it("rejects a provider name beyond the VARCHAR(120) limit", () => {
    expect(() =>
      providerConfigInputSchema.parse({ ...base, providerName: "p".repeat(121) }),
    ).toThrow();
  });

  it("rejects an apiKey beyond the 4096-character cap", () => {
    expect(() =>
      providerConfigInputSchema.parse({ ...base, apiKey: "k".repeat(4097) }),
    ).toThrow();
  });
});

describe("validateProviderTarget (target rules independent of capabilities)", () => {
  it("validates the same target rules as create/update, usable before a row exists", () => {
    expect(
      validateProviderTarget({ providerType: "preset", providerName: "openai" }).normalizedBaseUrl,
    ).toBeNull();
    expect(
      validateProviderTarget({
        providerType: "custom",
        providerName: "my-endpoint",
        baseUrl: "  https://API.Example.COM/v1  ",
      }).normalizedBaseUrl,
    ).toBe("https://api.example.com/v1");
    try {
      validateProviderTarget({
        providerType: "custom",
        providerName: "openai",
        baseUrl: "https://api.example.com/v1",
      });
      expect.unreachable("preset names are reserved");
    } catch (error) {
      expect((error as ProviderConfigError).code).toBe("reserved_preset_name");
    }
  });
});

describe("validateProviderRules", () => {
  it("accepts a preset that declares the requested capabilities", () => {
    const rules = validateProviderRules({
      providerType: "preset",
      providerName: "openai",
      capabilities: { asr: { modelId: "whisper-1" }, llm: { modelId: "gpt-4o" } },
    });
    expect(rules.normalizedBaseUrl).toBeNull();
  });

  it("accepts a preset serving the scorer capability it declares", () => {
    const rules = validateProviderRules({
      providerType: "preset",
      providerName: "openai",
      capabilities: { scorer: { modelId: "gpt-4o-mini" } },
    });
    expect(rules.normalizedBaseUrl).toBeNull();
  });

  it("rejects a tts-only preset used for the scorer capability", () => {
    try {
      validateProviderRules({
        providerType: "preset",
        providerName: "elevenlabs",
        capabilities: { scorer: { modelId: "x" } },
      });
      expect.unreachable("tts-only presets cannot serve scorer");
    } catch (error) {
      expect((error as ProviderConfigError).code).toBe("capability_not_supported");
    }
  });

  it("rejects an unknown preset name", () => {
    try {
      validateProviderRules({
        providerType: "preset",
        providerName: "does-not-exist",
        capabilities: { llm: { modelId: "x" } },
      });
      expect.unreachable("unknown preset must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigError);
      expect((error as ProviderConfigError).code).toBe("unknown_preset");
    }
  });

  it("rejects a preset used for a capability it does not declare (openai+tts)", () => {
    try {
      validateProviderRules({
        providerType: "preset",
        providerName: "openai",
        capabilities: { tts: { modelId: "tts-1" } },
      });
      expect.unreachable("openai cannot serve tts in the registry");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigError);
      expect((error as ProviderConfigError).code).toBe("capability_not_supported");
    }
  });

  it("rejects a preset row that carries its own Base URL", () => {
    try {
      validateProviderRules({
        providerType: "preset",
        providerName: "openai",
        baseUrl: "https://api.openai.com/v1",
        capabilities: { llm: { modelId: "gpt-4o" } },
      });
      expect.unreachable("presets must not carry a Base URL");
    } catch (error) {
      expect((error as ProviderConfigError).code).toBe("invalid_input");
    }
  });

  it("rejects a custom endpoint shadowing a reserved preset name", () => {
    try {
      validateProviderRules({
        providerType: "custom",
        providerName: "openai",
        baseUrl: "https://api.example.com/v1",
        capabilities: { llm: { modelId: "gpt-4o" } },
      });
      expect.unreachable("preset names are reserved");
    } catch (error) {
      expect((error as ProviderConfigError).code).toBe("reserved_preset_name");
    }
  });

  it("rejects a custom endpoint without a Base URL", () => {
    try {
      validateProviderRules({
        providerType: "custom",
        providerName: "my-endpoint",
        capabilities: { llm: { modelId: "gpt-4o" } },
      });
      expect.unreachable("custom requires a Base URL");
    } catch (error) {
      expect((error as ProviderConfigError).code).toBe("invalid_input");
    }
  });

  it("normalises a custom Base URL and rejects blocked destinations", () => {
    const rules = validateProviderRules({
      providerType: "custom",
      providerName: "my-endpoint",
      baseUrl: "  https://API.Example.COM/v1  ",
      capabilities: { llm: { modelId: "gpt-4o" } },
    });
    expect(rules.normalizedBaseUrl).toBe("https://api.example.com/v1");

    try {
      validateProviderRules({
        providerType: "custom",
        providerName: "my-endpoint",
        baseUrl: "http://127.0.0.1:8080/v1",
        capabilities: { llm: { modelId: "gpt-4o" } },
      });
      expect.unreachable("loopback destinations must be rejected");
    } catch (error) {
      expect((error as ProviderConfigError).code).toBe("invalid_base_url");
    }
  });
});

describe("error taxonomy", () => {
  it("keeps provider config errors distinct from crypto errors", () => {
    const configError = new ProviderConfigError("not_found", "missing");
    const cryptoError = new ProviderCryptoError("decrypt_failed", "tampered");
    expect(configError.name).toBe("ProviderConfigError");
    expect(cryptoError.name).toBe("ProviderCryptoError");
    expect(configError.code).toBe("not_found");
    expect(cryptoError.code).toBe("decrypt_failed");
  });
});

describe("enablement gate (FR-PROVIDER-006: a failed test prevents enabling)", () => {
  it("refuses to enable a configuration whose capability probe failed", () => {
    expect(() => assertEnablementAllowed("invalid", true)).toThrowError(ProviderConfigError);
    expect(() => assertEnablementAllowed("invalid", true)).toThrowError(/probe/i);
  });

  it("allows enabling valid and unvalidated configurations, and disabling any", () => {
    expect(() => assertEnablementAllowed("valid", true)).not.toThrow();
    expect(() => assertEnablementAllowed("unvalidated", true)).not.toThrow();
    expect(() => assertEnablementAllowed("invalid", false)).not.toThrow();
  });
});
