import { describe, expect, it, vi } from "vitest";
import { createRealtimeToken, type RealtimeTokenResult } from "./realtime-token";

/** Hermetic tests for the token-scoped Gemini Live setup (TT-8 realtime mode). */
const route = {
  providerName: "google",
  providerType: "preset",
  baseUrl: "https://generativelanguage.googleapis.com",
  modelId: "gemini-3.1-flash-live-preview",
  apiKey: "secret-key",
};

describe("createRealtimeToken", () => {
  it("mints a short-lived session with transcription enabled using the caller's key", async () => {
    const calls: unknown[] = [];
    const getToken = vi.fn(async (options: unknown) => {
      calls.push(options);
      return { token: "ephemeral", url: "wss://live.example", expiresAt: 123 };
    });

    const result: RealtimeTokenResult = await createRealtimeToken(route, {
      createProvider: () => ({ experimental_realtime: { getToken } }) as never,
      getTokenFor: undefined,
    });

    expect(result).toEqual({ token: "ephemeral", url: "wss://live.example", expiresAt: 123 });
    expect(getToken).toHaveBeenCalledTimes(1);
    const options = calls[0] as {
      model: string;
      sessionConfig: { inputAudioTranscription: object; outputAudioTranscription: object };
    };
    expect(options.model).toBe("gemini-3.1-flash-live-preview");
    expect(options.sessionConfig.inputAudioTranscription).toEqual({});
    expect(options.sessionConfig.outputAudioTranscription).toEqual({});
  });

  it("never includes the API key in the token result", async () => {
    const result = await createRealtimeToken(route, {
      createProvider: undefined,
      getTokenFor: async () => ({ token: "t", url: "wss://x", expiresAt: 1 }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });
});
