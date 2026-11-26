import { describe, expect, it, vi } from "vitest";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import {
  createRealtimeToken,
  type LiveSessionConfig,
  type RealtimeTokenResult,
} from "./realtime-token";

/** Hermetic tests for the token-scoped Gemini Live setup (TT-8 realtime mode). */
const route: ProviderRoute = {
  providerName: "google",
  providerType: "preset",
  baseUrl: "https://generativelanguage.googleapis.com",
  modelId: "gemini-3.1-flash-live-preview",
  apiKey: "secret-key",
};

const session: LiveSessionConfig = {
  instructions: "You are the AIMIS AI interviewer conducting a live voice mock interview.",
  sessionConfig: {
    instructions: "You are the AIMIS AI interviewer conducting a live voice mock interview.",
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    outputModalities: ["audio"],
  },
};

describe("createRealtimeToken", () => {
  it("mints a short-lived session with the shared config (instructions included) using the caller's key", async () => {
    const calls: unknown[] = [];
    const getToken = vi.fn(async (options: unknown) => {
      calls.push(options);
      return { token: "ephemeral", url: "wss://live.example", expiresAt: 123 };
    });

    const result: RealtimeTokenResult = await createRealtimeToken(route, session, {
      createProvider: () => ({ experimental_realtime: { getToken } }),
    });

    expect(result).toEqual({ token: "ephemeral", url: "wss://live.example", expiresAt: 123 });
    expect(getToken).toHaveBeenCalledTimes(1);
    const options = calls[0] as {
      model: string;
      sessionConfig: {
        instructions: string;
        inputAudioTranscription: object;
        outputAudioTranscription: object;
        outputModalities: string[];
      };
    };
    // The exact configured model id is preserved; the interview instructions
    // (role/JD/budget, FR-INTERVIEW-003) are baked into the client secret so
    // the live model is configured, not a generic chat.
    expect(options.model).toBe("gemini-3.1-flash-live-preview");
    expect(options.sessionConfig.instructions).toBe(session.instructions);
    expect(options.sessionConfig.inputAudioTranscription).toEqual({});
    expect(options.sessionConfig.outputAudioTranscription).toEqual({});
    expect(options.sessionConfig.outputModalities).toEqual(["audio"]);
  });

  it("never includes the API key in the token result", async () => {
    const result = await createRealtimeToken(route, session, {
      createProvider: () => ({
        experimental_realtime: {
          getToken: async () => ({ token: "t", url: "wss://x", expiresAt: 1 }),
        },
      }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("refuses non-Google realtime routes with a typed error before any provider call (fail closed)", async () => {
    const createProvider = vi.fn(() => ({ experimental_realtime: { getToken: vi.fn() } }));

    await expect(
      createRealtimeToken(
        { ...route, providerName: "openai", modelId: "gpt-realtime-x" },
        session,
        { createProvider },
      ),
    ).rejects.toMatchObject({ name: "RealtimeError", code: "unsupported_provider" });
    expect(createProvider).not.toHaveBeenCalled();
  });
});
