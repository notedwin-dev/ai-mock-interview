import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AIMIS_ELEVENLABS_REALTIME_MODEL_ID, AIMIS_REALTIME_MODEL_ID } from "./constants";
import { realtimeModelFor } from "@/lib/providers/realtime-models";

/**
 * The LiveKit agent's exact model ID is admin-fixed (owner decision 2026-11-20,
 * ADR-006) and must be preserved: the agent, the app's realtime catalogue and
 * the shared constant all reference the SAME value (owner decision 2026-11-23).
 * This test pins the catalogue to the constant so the deployed worker and the
 * candidate-facing configuration can never drift apart, and asserts the agent
 * imports the constant instead of hardcoding a model literal (source boundary,
 * since the agent script is a standalone ESM worker, not a unit-importable
 * module).
 */
describe("shared admin-fixed realtime model id", () => {
  it("is the admin-fixed Google realtime model", () => {
    expect(AIMIS_REALTIME_MODEL_ID).toBe("gemini-3.8-live-extended-thinking");
  });

  it("matches the admin-fixed Google entry in the app catalogue", () => {
    expect(realtimeModelFor("google")).toBe(AIMIS_REALTIME_MODEL_ID);
  });
});

describe("shared admin-fixed ElevenLabs realtime model id", () => {
  it("is the exact ElevenLabs realtime model", () => {
    expect(AIMIS_ELEVENLABS_REALTIME_MODEL_ID).toBe("eleven_realtime_v1_mini");
  });

  it("matches the admin-fixed ElevenLabs entry in the app catalogue", () => {
    expect(realtimeModelFor("elevenlabs")).toBe(AIMIS_ELEVENLABS_REALTIME_MODEL_ID);
  });
});

describe("LiveKit agent sources the model id from the shared constant", () => {
  const agentSource = readFileSync("scripts/livekit-agent.mjs", "utf8");

  it("imports AIMIS_REALTIME_MODEL_ID from the constants module", () => {
    expect(agentSource).toMatch(
      /import\s*\{[^}]*AIMIS_REALTIME_MODEL_ID[^}]*\}\s*from\s*"\.\.\/src\/lib\/utils\/constants\.mjs"/s,
    );
    expect(agentSource).toMatch(/REALTIME_MODEL\s*=\s*AIMIS_REALTIME_MODEL_ID/);
  });

  it("no longer hardcodes a provider model literal", () => {
    // The stale Gemini Live preview id must be gone; the only model id in the
    // agent comes from the shared constant.
    expect(agentSource).not.toContain("gemini-3.1-flash-live-preview");
    expect(agentSource).not.toMatch(/model:\s*"/);
  });
});
