import { describe, expect, it } from "vitest";
import { synthesizeSpeech, TtsError, type TtsRoute } from "./tts";

/**
 * Hermetic tests for the provider-aware interviewer voice adapter
 * (TT-9/TT-26; ADR-0005/006, ADR-030 + OWNER-020/021). Each wire is asserted
 * against a mock fetch: exact endpoint, credential header (key only there,
 * never in errors), and the EXACT configured model id in every request.
 */
const fishRoute: TtsRoute = {
  providerName: "fish-audio",
  providerType: "preset",
  baseUrl: "https://api.fish.audio",
  modelId: "s2.1-pro-free",
  apiKey: "sk-secret",
};

const openAiRoute: TtsRoute = {
  providerName: "openai",
  providerType: "preset",
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-4o-mini-tts",
  apiKey: "sk-tts-secret",
};

const googleRoute: TtsRoute = {
  providerName: "google",
  providerType: "preset",
  baseUrl: "https://generativelanguage.googleapis.com",
  modelId: "gemini-tts-2.5-flash-preview",
  apiKey: "goog-tts-secret",
};

const elevenRoute: TtsRoute = {
  providerName: "elevenlabs",
  providerType: "preset",
  baseUrl: "https://api.elevenlabs.io",
  modelId: "eleven_v3",
  apiKey: "xi-tts-secret",
};

function mockFetch(response: { ok: boolean; status: number; bytes?: Uint8Array }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const source = response.bytes ?? new Uint8Array([1, 2, 3]);
    const bytes = new Uint8Array(source.length); // ArrayBuffer-backed for Blob's strict types
    bytes.set(source);
    return new Response(new Blob([bytes]), { status: response.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("synthesizeSpeech", () => {
  it("always sends the exact configured model in the Fish Audio model header", async () => {
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });

    const bytes = await synthesizeSpeech(fishRoute, "Hello", { fetchImpl });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.fish.audio/v1/tts");
    // Omitting the header silently serves the PAID s2.1-pro — never do that.
    expect(calls[0]!.headers["model"]).toBe("s2.1-pro-free");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer sk-secret");
    expect(JSON.parse(calls[0]!.body)).toEqual({ text: "Hello", format: "mp3" });
  });

  it("openai preset: OpenAI-compatible /audio/speech with Bearer key and exact model", async () => {
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });

    await synthesizeSpeech(openAiRoute, "Hi there", { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer sk-tts-secret");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      model: "gpt-4o-mini-tts",
      input: "Hi there",
      voice: "alloy",
      response_format: "mp3",
    });
  });

  it("google preset: OpenAI-compatible wire under the /v1beta/openai root, exact model", async () => {
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });

    await synthesizeSpeech(googleRoute, "Good morning", { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/audio/speech");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer goog-tts-secret");
    const body = JSON.parse(calls[0]!.body);
    expect(body.model).toBe("gemini-tts-2.5-flash-preview");
    expect(body.input).toBe("Good morning");
  });

  it("elevenlabs preset: native TTS path with xi-api-key, exact model, NO voice field", async () => {
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });

    const bytes = await synthesizeSpeech(elevenRoute, "Welcome to the interview.", { fetchImpl });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/eleven_v3?output_format=mp3_44100_128",
    );
    expect(calls[0]!.headers["xi-api-key"]).toBe("xi-tts-secret");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    const body = JSON.parse(calls[0]!.body);
    expect(body.text).toBe("Welcome to the interview.");
    expect(body.model_id).toBe("eleven_v3");
    // OWNER-021: Voice Library voices are unavailable on the free tier, so the
    // adapter must never send a voice id (provider default is correct).
    expect(body.voice).toBeUndefined();
  });

  it("a custom row pointing at api.elevenlabs.io uses the native wire by host", async () => {
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });
    const route = { ...elevenRoute, providerType: "custom", providerName: "relay" };

    await synthesizeSpeech(route, "Hi", { fetchImpl });

    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/eleven_v3?output_format=mp3_44100_128");
    expect(calls[0]!.headers["xi-api-key"]).toBe("xi-tts-secret");
  });

  it("uses the OpenAI-compatible speech wire for other routes", async () => {
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });
    const route = { ...fishRoute, providerName: "my-gateway", baseUrl: "https://gw.example/v1", modelId: "voice-model" };

    await synthesizeSpeech(route, "Hi", { fetchImpl });

    expect(calls[0]!.url).toBe("https://gw.example/v1/audio/speech");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ model: "voice-model", input: "Hi" });
    expect(calls[0]!.headers["model"]).toBeUndefined();
  });

  it("reports provider failures as typed errors without leaking the key (all wires)", async () => {
    for (const route of [fishRoute, openAiRoute, googleRoute, elevenRoute]) {
      const fetchImpl = (async () =>
        new Response(`no credit for key ${route.apiKey} at ${route.baseUrl}`, { status: 402 })) as typeof fetch;
      try {
        await synthesizeSpeech(route, "Hi", { fetchImpl });
        expect.unreachable("provider failure must reject");
      } catch (error) {
        expect(error).toBeInstanceOf(TtsError);
        expect((error as TtsError).code).toBe("generation_failed");
        expect((error as Error).message).not.toContain(route.apiKey);
        expect((error as Error).message).not.toContain(route.baseUrl);
      }
    }
  });

  it("reports empty audio as invalid_audio", async () => {
    const { fetchImpl } = mockFetch({ ok: true, status: 200, bytes: new Uint8Array(0) });
    try {
      await synthesizeSpeech(openAiRoute, "Hi", { fetchImpl });
      expect.unreachable("empty audio must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(TtsError);
      expect((error as TtsError).code).toBe("invalid_audio");
    }
  });
});
