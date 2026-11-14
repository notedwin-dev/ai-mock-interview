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
});
