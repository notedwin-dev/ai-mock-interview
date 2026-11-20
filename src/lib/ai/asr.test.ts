import { describe, expect, it } from "vitest";
import { transcribeAudio, AsrError, type AsrRoute } from "./asr";

/** Hermetic tests for the Gemini transcription wire (TT-9; official docs). */
const route: AsrRoute = {
  providerName: "google",
  providerType: "preset",
  baseUrl: "https://generativelanguage.googleapis.com",
  modelId: "gemini-3.5-transcribe",
  apiKey: "secret-key",
};

function mockFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("transcribeAudio", () => {
  it("sends inline base64 audio to Gemini's documented interactions endpoint", async () => {
    const { fetchImpl, calls } = mockFetch({ output_text: "I fixed a slow query." });

    const text = await transcribeAudio(route, new Uint8Array([1, 2, 3]), "audio/wav", { fetchImpl });

    expect(text).toBe("I fixed a slow query.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("secret-key");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    const payload = JSON.parse(calls[0]!.body);
    expect(payload.model).toBe("models/gemini-3.5-transcribe");
    expect(payload.input[0]).toMatchObject({ type: "audio", data: "AQID", mime_type: "audio/wav" });
  });

  it("reads the transcript from steps when output_text is absent", async () => {
    const { fetchImpl } = mockFetch({
      steps: [{ content: [{ type: "text", text: "Second answer." }] }],
    });
    await expect(
      transcribeAudio(route, new Uint8Array([4]), "audio/webm", { fetchImpl }),
    ).resolves.toBe("Second answer.");
  });

  it("never prefixes the model twice and reports failures without leaking the key", async () => {
    const { fetchImpl, calls } = mockFetch({ output_text: "ok" });
    await transcribeAudio({ ...route, modelId: "models/gemini-3.5-transcribe" }, new Uint8Array([1]), "audio/wav", { fetchImpl });
    expect(JSON.parse(calls[0]!.body).model).toBe("models/gemini-3.5-transcribe");

    const failed = mockFetch({ error: { message: "invalid key secret-key" } }, 401);
    try {
      await transcribeAudio(route, new Uint8Array([1]), "audio/wav", { fetchImpl: failed.fetchImpl });
      expect.unreachable("provider failure must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AsrError);
      expect((error as Error).message).not.toContain("secret-key");
    }
  });
});
