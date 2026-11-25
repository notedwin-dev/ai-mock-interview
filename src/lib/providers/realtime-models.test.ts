import { describe, expect, it } from "vitest";
import { AIMIS_ELEVENLABS_REALTIME_MODEL_ID } from "@/lib/utils/constants";
import { applyRealtimeModelRules, realtimeModelFor } from "./realtime-models";

describe("admin-fixed realtime models", () => {
  it("exposes only researched realtime model IDs, free-tier first", () => {
    expect(realtimeModelFor("google")).toBe("gemini-3.8-live-extended-thinking");
    expect(realtimeModelFor("openai")).toBe("gpt-live-1.1");
    expect(realtimeModelFor("elevenlabs")).toBe("eleven_realtime_v1_mini");
    expect(realtimeModelFor("fish-audio")).toBeNull();
  });

  it("keeps the ElevenLabs entry pinned to the shared admin constant", () => {
    // Sourcing the entry from the shared constant keeps the catalogue, the
    // token minter and the wire in lockstep (owner decision 2026-11-25).
    expect(realtimeModelFor("elevenlabs")).toBe(AIMIS_ELEVENLABS_REALTIME_MODEL_ID);
  });

  it("overrides a user-supplied realtime model with the admin-fixed ID", () => {
    const result = applyRealtimeModelRules(
      { realtime: { modelId: "user-invented-model" } },
      "google",
    );
    expect(result.realtime?.modelId).toBe("gemini-3.8-live-extended-thinking");
    const eleven = applyRealtimeModelRules(
      { realtime: { modelId: "user-invented-model" } },
      "elevenlabs",
    );
    expect(eleven.realtime?.modelId).toBe("eleven_realtime_v1_mini");
  });

  it("refuses realtime configurations for providers with no verified model", () => {
    expect(() =>
      applyRealtimeModelRules({ realtime: { modelId: "anything" } }, "fish-audio"),
    ).toThrow(/not available/i);
  });

  it("leaves custom capabilities untouched", () => {
    const caps = { llm: { modelId: "baidu/ernie-5.5-flash-preview:free" } };
    expect(applyRealtimeModelRules(caps, "google")).toEqual(caps);
  });
});
