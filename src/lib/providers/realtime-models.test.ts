import { describe, expect, it } from "vitest";
import { applyRealtimeModelRules, realtimeModelFor } from "./realtime-models";

describe("admin-fixed realtime models", () => {
  it("exposes only researched realtime model IDs, free-tier first", () => {
    expect(realtimeModelFor("google")).toBe("gemini-3.8-live-extended-thinking");
    expect(realtimeModelFor("openai")).toBe("gpt-realtime");
    expect(realtimeModelFor("elevenlabs")).toBeNull();
    expect(realtimeModelFor("fish-audio")).toBeNull();
  });

  it("overrides a user-supplied realtime model with the admin-fixed ID", () => {
    const result = applyRealtimeModelRules(
      { realtime: { modelId: "user-invented-model" } },
      "google",
    );
    expect(result.realtime?.modelId).toBe("gemini-3.8-live-extended-thinking");
  });

  it("refuses realtime configurations for providers with no verified model", () => {
    expect(() =>
      applyRealtimeModelRules({ realtime: { modelId: "anything" } }, "elevenlabs"),
    ).toThrow(/not available/i);
  });

  it("leaves custom capabilities untouched", () => {
    const caps = { llm: { modelId: "baidu/ernie-5.5-flash-preview:free" } };
    expect(applyRealtimeModelRules(caps, "google")).toEqual(caps);
  });
});
