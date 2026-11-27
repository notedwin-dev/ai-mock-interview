import { describe, expect, it } from "vitest";
import type { ProviderConfigSummary } from "@/lib/providers/config";
import { buildRealtimeLaunchInput, selectRuntime } from "./runtime";

function row(
  providerName: string,
  capabilities: Record<string, { modelId: string }>,
  overrides: Partial<ProviderConfigSummary> = {},
): ProviderConfigSummary {
  return {
    userProviderConfigurationId: providerName,
    providerType: "preset",
    providerName,
    baseUrl: null,
    capabilities,
    credentialStatus: "valid",
    isEnabled: true,
    configurationVersion: 1,
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectRuntime (ADR-006 mutually exclusive runtimes)", () => {
  it("chooses the realtime path when only a realtime agent is configured", () => {
    const result = selectRuntime([
      row("google", { realtime: { modelId: "gemini-3.8-live-extended-thinking" } }),
    ]);
    expect(result).toMatchObject({
      mode: "realtime",
      ready: true,
      servingProvider: "google",
    });
    expect(result.requiredCapabilities).toEqual([]);
  });

  it("does not require ASR/LLM/TTS when realtime is configured, even if custom rows are missing", () => {
    const result = selectRuntime([
      row("google", { realtime: { modelId: "gemini-3.8-live" } }),
      row("smoke", { asr: { modelId: "x" } }, { credentialStatus: "unvalidated" }),
    ]);
    expect(result.mode).toBe("realtime");
    expect(result.ready).toBe(true);
  });

  it("uses the custom path only when no realtime row exists, gating on LLM", () => {
    const result = selectRuntime([
      row("openrouter", { llm: { modelId: "baidu/ernie-5.5-flash-preview:free" } }),
      row("fish-audio", { tts: { modelId: "s2.1-pro-free" } }),
    ]);
    expect(result).toMatchObject({ mode: "custom", ready: true, servingProvider: "openrouter" });
  });

  it("reports the missing LLM for a custom account with only TTS/scorer", () => {
    const result = selectRuntime([
      row("fish", { tts: { modelId: "s2.1-pro-free" } }),
      row("scorer", { scorer: { modelId: "gpt" } }),
    ]);
    expect(result).toMatchObject({ mode: "custom", ready: false });
    expect(result.requiredCapabilities).toEqual(["llm"]);
  });

  it("prefers a validated provider over an older unvalidated one", () => {
    const result = selectRuntime([
      row("old-dummy", { llm: { modelId: "dummy" } }, { credentialStatus: "unvalidated" }),
      row("OpenRouter Free", { llm: { modelId: "free-model" } }, { credentialStatus: "valid" }),
    ]);
    expect(result.servingProvider).toBe("OpenRouter Free");
  });

  it("reports no runtime when nothing is configured", () => {
    expect(selectRuntime([])).toMatchObject({ mode: "none", ready: false });
  });
});

describe("buildRealtimeLaunchInput", () => {
  it("launches a realtime interview without requiring custom ASR/LLM/TTS rows", () => {
    expect(
      buildRealtimeLaunchInput("11111111-1111-4111-8111-111111111111", "rigorous"),
    ).toEqual({
      jobRole: "General practice",
      jobDescription: undefined,
      categoryId: "11111111-1111-4111-8111-111111111111",
      evaluationMode: "rigorous",
      runtimeMode: "preset_realtime",
    });
  });
});
