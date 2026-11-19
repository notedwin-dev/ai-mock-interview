import { describe, expect, it } from "vitest";
import { synthesizeSpeech, TtsError, type TtsRoute } from "./tts";

/** Hermetic tests for the interviewer voice adapter (TT-9; ADR-0005). */
const fishRoute: TtsRoute = {
  providerName: "fish-audio",
  providerType: "preset",
  baseUrl: "https://api.fish.audio",
  modelId: "s2.1-pro-free",
  apiKey: "sk-secret",
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

  it("uses the OpenAI-compatible speech wire for other routes", async () => {
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });
    const route = { ...fishRoute, providerName: "my-gateway", baseUrl: "https://gw.example/v1", modelId: "voice-model" };

    await synthesizeSpeech(route, "Hi", { fetchImpl });

    expect(calls[0]!.url).toBe("https://gw.example/v1/audio/speech");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ model: "voice-model", input: "Hi" });
    expect(calls[0]!.headers["model"]).toBeUndefined();
  });

  it("reports provider failures as typed errors without leaking the key", async () => {
    const fetchImpl = (async () => new Response("no credit", { status: 402 })) as typeof fetch;
    try {
      await synthesizeSpeech(fishRoute, "Hi", { fetchImpl });
      expect.unreachable("provider failure must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(TtsError);
      expect((error as TtsError).code).toBe("generation_failed");
      expect((error as Error).message).not.toContain("sk-secret");
    }
  });
});
