import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AIMIS_ELEVENLABS_REALTIME_MODEL_ID,
  AIMIS_REALTIME_MODEL_ID,
  AIMIS_WORKER_TOKEN_HEADER,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_VERSION_HEADER_NAME,
  ASR_STREAM_MAX_AGE_MS,
  CAPTION_TOPIC,
  GOOGLE_INTERACTIONS_PATH,
  GOOGLE_OPENAI_COMPAT_PATH,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  LK_TRANSCRIPTION_TOPIC,
  LLM_TIMEOUT_MS,
  OPENAI_COMPAT_DEFAULT_VOICE,
  X_API_KEY_HEADER,
  X_GOOG_API_KEY_HEADER,
  XI_API_KEY_HEADER,
} from "./constants";
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

describe("shared provider wire constants (OWNER-023 centralization)", () => {
  it("fixes the provider credential and version header names", () => {
    expect(XI_API_KEY_HEADER).toBe("xi-api-key");
    expect(X_GOOG_API_KEY_HEADER).toBe("x-goog-api-key");
    expect(X_API_KEY_HEADER).toBe("x-api-key");
    expect(ANTHROPIC_VERSION_HEADER_NAME).toBe("anthropic-version");
    expect(ANTHROPIC_API_VERSION).toBe("2023-06-01");
    expect(AIMIS_WORKER_TOKEN_HEADER).toBe("x-aimis-worker-token");
  });

  it("fixes the Google wire paths and the OpenAI-compatible default voice", () => {
    expect(GOOGLE_OPENAI_COMPAT_PATH).toBe("/v1beta/openai");
    expect(GOOGLE_INTERACTIONS_PATH).toBe("/v1beta/interactions");
    expect(OPENAI_COMPAT_DEFAULT_VOICE).toBe("alloy");
  });

  it("fixes the idempotency key contract (schema v0.4 VARCHAR(100))", () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(100);
    expect(IDEMPOTENCY_KEY_PATTERN).toEqual(/^[A-Za-z0-9._:-]{1,100}$/);
    expect(IDEMPOTENCY_KEY_PATTERN.test("turn-1")).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("bad key!")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("k".repeat(101))).toBe(false);
  });

  it("fixes the generation and streaming-ASR bounds", () => {
    expect(LLM_TIMEOUT_MS).toBe(90_000);
    expect(ASR_STREAM_MAX_AGE_MS).toBe(10 * 60 * 1000);
  });

  it("fixes the LiveKit room topics", () => {
    expect(CAPTION_TOPIC).toBe("aimis-caption");
    expect(LK_TRANSCRIPTION_TOPIC).toBe("lk.transcription");
  });

  it("matches the LiveKit agent's worker token header (source boundary)", () => {
    const agentSource = readFileSync("scripts/livekit-agent.mjs", "utf8");
    expect(agentSource).toMatch(
      /import\s*\{[^}]*AIMIS_WORKER_TOKEN_HEADER[^}]*\}\s*from\s*"\.\.\/src\/lib\/utils\/constants\.mjs"/s,
    );
  });
});
