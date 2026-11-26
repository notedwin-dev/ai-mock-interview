import { describe, expect, it } from "vitest";
import { transcribeAudio, AsrError, type AsrRoute } from "./asr";

/**
 * Hermetic tests for the provider-aware ASR wires (TT-9/TT-26; official docs).
 * Each wire is asserted against a mock fetch: exact endpoint, credential
 * header (key only there, never in errors), and the EXACT configured model id.
 */
const googleRoute: AsrRoute = {
  providerName: "google",
  providerType: "preset",
  baseUrl: "https://generativelanguage.googleapis.com",
  modelId: "gemini-3.5-transcribe",
  apiKey: "secret-key",
};

const openAiRoute: AsrRoute = {
  providerName: "openai",
  providerType: "preset",
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-transcribe",
  apiKey: "sk-secret-key",
};

const elevenRoute: AsrRoute = {
  providerName: "elevenlabs",
  providerType: "preset",
  baseUrl: "https://api.elevenlabs.io",
  modelId: "scribe_v2",
  apiKey: "xi-secret-key",
};

const fishRoute: AsrRoute = {
  providerName: "fish-audio",
  providerType: "preset",
  baseUrl: "https://api.fish.audio",
  modelId: "transcribe-1-pro",
  apiKey: "fish-secret-key",
};

function mockFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("transcribeAudio", () => {
  it("fish-audio preset: native /v1/asr with Bearer key and exact model header", async () => {
    const { fetchImpl, calls } = mockFetch({ text: "Fish heard this." });

    const text = await transcribeAudio(fishRoute, new Uint8Array([5, 6]), "audio/wav", { fetchImpl });

    expect(text).toBe("Fish heard this.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.fish.audio/v1/asr");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer fish-secret-key");
    expect(calls[0]!.headers["model"]).toBe("transcribe-1-pro");
    const form = calls[0]!.body as FormData;
    expect(form.get("audio")).toBeInstanceOf(File);
    expect(form.get("model")).toBeNull(); // model travels in the header
  });

  it("a custom row pointing at fish.audio uses the native wire by host", async () => {
    const { fetchImpl, calls } = mockFetch({ text: "Host match." });
    const route = { ...fishRoute, providerType: "custom", providerName: "my-fish" };

    await transcribeAudio(route, new Uint8Array([1]), "audio/wav", { fetchImpl });

    expect(calls[0]!.url).toBe("https://api.fish.audio/v1/asr");
    expect(calls[0]!.headers["model"]).toBe("transcribe-1-pro");
  });

  it("google preset: inline base64 audio to Gemini's documented interactions endpoint", async () => {
    const { fetchImpl, calls } = mockFetch({ output_text: "I fixed a slow query." });

    const text = await transcribeAudio(googleRoute, new Uint8Array([1, 2, 3]), "audio/wav", { fetchImpl });

    expect(text).toBe("I fixed a slow query.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("secret-key");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    const payload = JSON.parse(String(calls[0]!.body));
    expect(payload.model).toBe("models/gemini-3.5-transcribe");
    expect(payload.input[0]).toMatchObject({ type: "audio", data: "AQID", mime_type: "audio/wav" });
  });

  it("google preset reads the transcript from steps when output_text is absent", async () => {
    const { fetchImpl } = mockFetch({
      steps: [{ content: [{ type: "text", text: "Second answer." }] }],
    });
    await expect(
      transcribeAudio(googleRoute, new Uint8Array([4]), "audio/webm", { fetchImpl }),
    ).resolves.toBe("Second answer.");
  });

  it("never prefixes the google model twice", async () => {
    const { fetchImpl, calls } = mockFetch({ output_text: "ok" });
    await transcribeAudio({ ...googleRoute, modelId: "models/gemini-3.5-transcribe" }, new Uint8Array([1]), "audio/wav", { fetchImpl });
    expect(JSON.parse(String(calls[0]!.body)).model).toBe("models/gemini-3.5-transcribe");
  });

  it("openai preset: multipart /audio/transcriptions with Bearer key and exact model", async () => {
    const { fetchImpl, calls } = mockFetch({ text: "OpenAI heard this." });

    const text = await transcribeAudio(openAiRoute, new Uint8Array([9, 9]), "audio/webm", { fetchImpl });

    expect(text).toBe("OpenAI heard this.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer sk-secret-key");
    expect(calls[0]!.headers["xi-api-key"]).toBeUndefined();
    const form = calls[0]!.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe("audio/webm");
  });

  it("a custom row pointing at api.openai.com uses the OpenAI wire by host", async () => {
    const { fetchImpl, calls } = mockFetch({ text: "Host match." });
    const route = { ...openAiRoute, providerType: "custom", providerName: "my-gateway" };

    await transcribeAudio(route, new Uint8Array([1]), "audio/wav", { fetchImpl });

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer sk-secret-key");
  });

  it("elevenlabs preset: multipart /v1/speech-to-text with xi-api-key and exact model_id", async () => {
    const { fetchImpl, calls } = mockFetch({ text: "Scribe transcribed it." });

    const text = await transcribeAudio(elevenRoute, new Uint8Array([7]), "audio/webm", { fetchImpl });

    expect(text).toBe("Scribe transcribed it.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(calls[0]!.headers["xi-api-key"]).toBe("xi-secret-key");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    const form = calls[0]!.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("model")).toBeNull();
    expect(form.get("file")).toBeInstanceOf(File);
  });

  it("an OpenAI-compatible custom row keeps the generic wire", async () => {
    const { fetchImpl, calls } = mockFetch({ text: "Gateway heard it." });
    const route: AsrRoute = {
      providerName: "nim-gateway",
      providerType: "custom",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelId: "moonshotai/kimi-k3.1-pro",
      apiKey: "nim-secret",
    };

    await transcribeAudio(route, new Uint8Array([1]), "audio/wav", { fetchImpl });

    expect(calls[0]!.url).toBe("https://integrate.api.nvidia.com/v1/audio/transcriptions");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer nim-secret");
    expect((calls[0]!.body as FormData).get("model")).toBe("moonshotai/kimi-k3.1-pro");
  });

  it("an unrecognised preset name fails closed with a typed unsupported error (no wrong-wire call)", async () => {
    const { fetchImpl, calls } = mockFetch({ text: "should not be called" });
    const route: AsrRoute = {
      providerName: "unknown-stt",
      providerType: "preset",
      baseUrl: "https://stt.example.com/v1",
      modelId: "stt-1",
      apiKey: "whatever",
    };

    await expect(
      transcribeAudio(route, new Uint8Array([1]), "audio/wav", { fetchImpl }),
    ).rejects.toMatchObject({ name: "AsrError", code: "unsupported" });
    expect(calls).toHaveLength(0);
  });

  it("an empty provider transcript is empty_transcript, not a success", async () => {
    const { fetchImpl } = mockFetch({ text: "   " });
    await expect(
      transcribeAudio(openAiRoute, new Uint8Array([1]), "audio/wav", { fetchImpl }),
    ).rejects.toMatchObject({ name: "AsrError", code: "empty_transcript" });
  });

  it("provider failures never leak the key or the endpoint (all wires)", async () => {
    for (const route of [googleRoute, openAiRoute, elevenRoute]) {
      const { fetchImpl } = mockFetch(
        { error: { message: `invalid key ${route.apiKey} at ${route.baseUrl}` } },
        401,
      );
      try {
        await transcribeAudio(route, new Uint8Array([1]), "audio/wav", { fetchImpl });
        expect.unreachable("provider failure must reject");
      } catch (error) {
        expect(error).toBeInstanceOf(AsrError);
        expect((error as Error).message).not.toContain(route.apiKey);
        expect((error as Error).message).not.toContain(route.baseUrl);
      }
    }

    // Network-level failure is equally sanitised.
    const throwing = (async () => {
      throw new TypeError(`fetch failed ${openAiRoute.apiKey}`);
    }) as unknown as typeof fetch;
    try {
      await transcribeAudio(openAiRoute, new Uint8Array([1]), "audio/wav", { fetchImpl: throwing });
      expect.unreachable("network failure must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AsrError);
      expect((error as Error).message).not.toContain(openAiRoute.apiKey);
    }
  });
});
