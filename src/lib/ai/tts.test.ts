import { describe, expect, it, vi } from "vitest";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import { assertTtsWireSupported, synthesizeSpeech, TtsError } from "./tts";

/** Hermetic tests for the interviewer voice adapter (TT-9; ADR-0005). */
const fishRoute: ProviderRoute = {
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

  it("uses the OpenAI-compatible speech wire for custom gateways", async () => {
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });
    const route: ProviderRoute = {
      providerName: "my-gateway",
      providerType: "custom",
      baseUrl: "https://gw.example/v1",
      modelId: "voice-model",
      apiKey: "sk-secret",
    };

    await synthesizeSpeech(route, "Hi", { fetchImpl });

    expect(calls[0]!.url).toBe("https://gw.example/v1/audio/speech");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ model: "voice-model", input: "Hi" });
    expect(calls[0]!.headers["model"]).toBeUndefined();
  });

  it("refuses presets without an implemented wire (elevenlabs, openai) before any network call", async () => {
    // The registry declares `tts` for elevenlabs/openai, but their native
    // wires are not implemented here: a typed unsupported_provider beats a
    // silent 502 (fail closed, FR-PROVIDER-006).
    const { fetchImpl } = mockFetch({ ok: true, status: 200 });
    const elevenlabs: ProviderRoute = {
      providerName: "elevenlabs",
      providerType: "preset",
      baseUrl: "https://api.elevenlabs.io",
      modelId: "eleven_v4",
      apiKey: "sk-secret",
    };

    await expect(synthesizeSpeech(elevenlabs, "Hi", { fetchImpl })).rejects.toMatchObject({
      name: "TtsError",
      code: "unsupported_provider",
    });
    // The pure pre-flight gate rejects the same routes without I/O, so the
    // room can refuse the turn BEFORE persisting anything.
    expect(() => assertTtsWireSupported(elevenlabs)).toThrowError(
      expect.objectContaining({ code: "unsupported_provider" }),
    );
    expect(() => assertTtsWireSupported(fishRoute)).not.toThrow();
    expect(() => assertTtsWireSupported({ ...elevenlabs, providerType: "custom", providerName: "my-voice" })).not.toThrow();
  });

  it("refuses unrecognised Fish Audio model ids before any network call (fail closed)", async () => {
    // The native wire always sends the id in the `model` header; an id outside
    // the documented catalogue would fail opaquely at the provider.
    const { fetchImpl, calls } = mockFetch({ ok: true, status: 200 });
    const unknown: ProviderRoute = { ...fishRoute, modelId: "made-up-model" };

    await expect(synthesizeSpeech(unknown, "Hi", { fetchImpl })).rejects.toMatchObject({
      name: "TtsError",
      code: "unsupported_provider",
    });
    expect(() => assertTtsWireSupported(unknown)).toThrowError(
      expect.objectContaining({ code: "unsupported_provider" }),
    );
    expect(calls).toHaveLength(0);

    // The documented list is still accepted, including s1 (retires 31 Dec 2026).
    expect(() => assertTtsWireSupported(fishRoute)).not.toThrow();
    expect(() => assertTtsWireSupported({ ...fishRoute, modelId: "s1" })).not.toThrow();
    // Custom OpenAI-compatible ids stay unrestricted.
    expect(() =>
      assertTtsWireSupported({ ...fishRoute, providerType: "custom", providerName: "gw", baseUrl: "https://gw.example/v1", modelId: "voice-x" }),
    ).not.toThrow();
  });

  it("aborts a stalled response body at the synthesis deadline and reports generation_failed", async () => {
    // A provider that returns headers promptly and then stalls mid-audio: the
    // deadline must cover body consumption, not just the initial fetch.
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
      return controller.signal;
    });
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Never enqueue and never close — the body hangs until aborted.
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    try {
      const settled = synthesizeSpeech(fishRoute, "Hi", { fetchImpl }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const outcome = await settled;

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      if (outcome.ok) throw new Error("the stalled body must reject, not resolve");
      expect(outcome.error).toBeInstanceOf(TtsError);
      expect((outcome.error as TtsError).code).toBe("generation_failed");
    } finally {
      vi.useRealTimers();
      timeoutSpy.mockRestore();
    }
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
