import { describe, expect, it } from "vitest";
import { CAPABILITIES, getPresetAdapter, PRESET_ADAPTERS } from "./registry";
import { evaluateBaseUrl } from "./ssrf";

describe("provider adapter registry", () => {
  it("has unique stable provider names", () => {
    const names = PRESET_ADAPTERS.map((preset) => preset.providerName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares only approved capabilities", () => {
    for (const preset of PRESET_ADAPTERS) {
      for (const capability of preset.capabilities) {
        expect(CAPABILITIES).toContain(capability);
      }
    }
  });

  it("every preset Base URL passes the SSRF guard", () => {
    for (const preset of PRESET_ADAPTERS) {
      expect(evaluateBaseUrl(preset.defaultBaseUrl)).toMatchObject({ ok: true });
    }
  });

  it("resolves presets by providerName", () => {
    expect(getPresetAdapter("openai")?.defaultBaseUrl).toBe(
      "https://api.openai.com/v1",
    );
    expect(getPresetAdapter("does-not-exist")).toBeUndefined();
  });

  it("implements the complete ADR-030 preset set", () => {
    expect(PRESET_ADAPTERS.map((preset) => preset.providerName)).toEqual([
      "openai",
      "anthropic",
      "google",
      "elevenlabs",
      "fish-audio",
      "deepseek",
      "zai-glm",
      "qwen",
    ]);
  });

  it("OpenAI-protocol LLM presets serve llm + scorer only with verified base URLs", () => {
    for (const [name, baseUrl] of [
      ["deepseek", "https://api.deepseek.com"],
      ["zai-glm", "https://api.z.ai/api/paas/v4"],
      ["qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ] as const) {
      const preset = getPresetAdapter(name);
      expect(preset?.defaultBaseUrl).toBe(baseUrl);
      expect(preset?.capabilities).toEqual(["llm", "scorer"]);
    }
  });

  it("declares the realtime capability only on the native realtime agent presets (register Option A)", () => {
    expect(CAPABILITIES).toContain("realtime");
    expect(getPresetAdapter("openai")?.capabilities).toContain("realtime");
    expect(getPresetAdapter("google")?.capabilities).toContain("realtime");
    for (const preset of PRESET_ADAPTERS) {
      if (preset.providerName === "openai" || preset.providerName === "google") continue;
      expect(preset.capabilities, preset.providerName).not.toContain("realtime");
    }
  });
});
