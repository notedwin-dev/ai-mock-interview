import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ELEVENLABS_REALTIME_API_BASE,
  ELEVENLABS_REALTIME_MODEL_ID,
  ELEVENLABS_REALTIME_WS_URL,
  createRealtimeToken,
  RealtimeTokenError,
  type RealtimeTokenResult,
} from "./realtime-token";

/**
 * Hermetic tests for the token-scoped realtime session setup
 * (TT-8 realtime mode; FR-INTERVIEW-003, ADR-006). No real provider is
 * called: Google goes through the injected `createProvider` fake, ElevenLabs
 * through an injected `fetchImpl` that records the mint request.
 */

const googleRoute = {
  providerName: "google",
  providerType: "preset",
  baseUrl: "https://generativelanguage.googleapis.com",
  modelId: "gemini-3.1-flash-live-preview",
  apiKey: "secret-key",
};

const elevenRoute = {
  providerName: "elevenlabs",
  providerType: "preset",
  baseUrl: "https://api.elevenlabs.io",
  modelId: "eleven_realtime_v1_mini",
  apiKey: "sk_elevenlabs_secret_key",
};

/** Records every call and replays the given (response, body) pair. */
function mockFetch(response: Response, calls: Array<{ url: string; init: RequestInit }>) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  });
  return fetchImpl;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRealtimeToken — google (existing wire, unchanged)", () => {
  it("mints a short-lived session with transcription enabled using the caller's key", async () => {
    const calls: unknown[] = [];
    const getToken = vi.fn(async (options: unknown) => {
      calls.push(options);
      return { token: "ephemeral", url: "wss://live.example", expiresAt: 123 };
    });

    const result: RealtimeTokenResult = await createRealtimeToken(googleRoute, {
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
    const result = await createRealtimeToken(googleRoute, {
      createProvider: undefined,
      getTokenFor: async () => ({ token: "t", url: "wss://x", expiresAt: 1 }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });
});

describe("createRealtimeToken — elevenlabs (OpenAI-compatible Realtime API)", () => {
  it("mints a client secret from the documented endpoint with the xi-api-key header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = mockFetch(
      jsonResponse(200, { value: "el_short_lived_secret", expires_at: 1_700_000_000 }),
      calls,
    );

    const result = await createRealtimeToken(elevenRoute, { fetchImpl });

    expect(result).toEqual({
      token: "el_short_lived_secret",
      url: ELEVENLABS_REALTIME_WS_URL,
      expiresAt: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.url).toBe(
      `${ELEVENLABS_REALTIME_API_BASE}/v1/convai/realtime/client_secrets`,
    );
    const init = calls[0]?.init as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(init.method).toBe("POST");
    expect(init.headers["xi-api-key"]).toBe("sk_elevenlabs_secret_key");
    expect(JSON.parse(init.body)).toMatchObject({
      session: expect.objectContaining({ model: "eleven_realtime_v1_mini", type: "realtime" }),
      expires_after: { seconds: 600 },
    });
    // Browser-facing URL is the fixed Realtime WebSocket, never the REST mint URL.
    expect(result.url).toBe("wss://api.elevenlabs.io/v1/convai/realtime");
  });

  it("uses the provider expires_at when supplied", async () => {
    const now = vi.fn(() => 1_000_000_000_000);
    const fetchImpl = mockFetch(jsonResponse(200, { value: "s", expires_at: 1_700_000_000 }), []);
    const result = await createRealtimeToken(elevenRoute, { fetchImpl, now });
    expect(result.expiresAt).toBe(1_700_000_000 * 1000);
  });

  it("sends the stored model (never a substituted one) and the exact header name", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = mockFetch(jsonResponse(200, { value: "s" }), calls);
    await createRealtimeToken(
      { ...elevenRoute, modelId: "eleven_realtime_v1_mini" },
      { fetchImpl },
    );
    const body = JSON.parse(
      (calls[0]?.init as { body: string }).body,
    ) as { session: { model: string } };
    expect(body.session.model).toBe(ELEVENLABS_REALTIME_MODEL_ID);
    const headers = (calls[0]?.init as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).toContain("xi-api-key");
    expect(Object.keys(headers)).not.toContain("x-goog-api-key");
  });

  it("never leaks the stored key in the result or in any typed error", async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { value: "el_ok" }), []);
    const result = await createRealtimeToken(elevenRoute, { fetchImpl });
    expect(JSON.stringify(result)).not.toContain("sk_elevenlabs_secret_key");

    for (const [status, body] of [
      [401, { message: "API key not valid" }],
      [429, { message: "quota exceeded" }],
      [500, { message: "boom" }],
    ] as const) {
      const failing = mockFetch(jsonResponse(status, body), []);
      try {
        await createRealtimeToken(elevenRoute, { fetchImpl: failing });
        expect.unreachable("mint must fail on a non-2xx response");
      } catch (error) {
        expect(error).toBeInstanceOf(RealtimeTokenError);
        expect(JSON.stringify(error)).not.toContain("sk_elevenlabs_secret_key");
        expect(String((error as Error).stack ?? "")).not.toContain("sk_elevenlabs_secret_key");
      }
    }
  });

  it("maps 401 to a typed authentication failure", async () => {
    const fetchImpl = mockFetch(jsonResponse(401, { message: "API key not valid" }), []);
    const error = await createRealtimeToken(elevenRoute, { fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RealtimeTokenError);
    expect((error as RealtimeTokenError).errorCode).toBe("authentication_failed");
    expect((error as RealtimeTokenError).status).toBe(401);
    expect((error as RealtimeTokenError).message).toBe(
      "API key not valid — the provider rejected the credential.",
    );
  });

  it("maps 429 to a typed rate-limit failure", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(429, { message: "Rate limit exceeded, try again later" }),
      [],
    );
    const error = await createRealtimeToken(elevenRoute, { fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect((error as RealtimeTokenError).errorCode).toBe("rate_limited");
    expect((error as RealtimeTokenError).status).toBe(429);
  });

  it("maps other non-2xx to a sanitized provider error that does not echo the body", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(500, { message: "internal error sk_leaked_from_body should not survive" }),
      [],
    );
    const error = await createRealtimeToken(elevenRoute, { fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect((error as RealtimeTokenError).errorCode).toBe("provider_error");
    expect(String((error as Error).message)).not.toContain("sk_leaked_from_body");
    // Redaction rule: anything key-shaped is replaced, message is truncated.
    expect(String((error as Error).message)).toContain("[redacted]");
  });

  it("fails closed on an empty or missing client secret value", async () => {
    for (const body of [{ value: "" }, {}]) {
      const fetchImpl = mockFetch(jsonResponse(200, body), []);
      const error = await createRealtimeToken(elevenRoute, { fetchImpl }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RealtimeTokenError);
      expect((error as RealtimeTokenError).errorCode).toBe("provider_error");
      expect(JSON.stringify(error)).not.toContain("sk_elevenlabs_secret_key");
    }
  });

  it("fails closed on a malformed JSON body and on network errors", async () => {
    const malformed = mockFetch(new Response("<html>gateway</html>", { status: 200 }), []);
    const malformedError = await createRealtimeToken(elevenRoute, {
      fetchImpl: malformed,
    }).catch((e: unknown) => e);
    expect((malformedError as RealtimeTokenError).errorCode).toBe("provider_error");

    const network = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const networkError = await createRealtimeToken(elevenRoute, {
      fetchImpl: network as never,
    }).catch((e: unknown) => e);
    expect(networkError).toBeInstanceOf(RealtimeTokenError);
    expect((networkError as RealtimeTokenError).errorCode).toBe("provider_error");
    expect(JSON.stringify(networkError)).not.toContain("sk_elevenlabs_secret_key");
  });
});

describe("createRealtimeToken — unsupported providers fail closed", () => {
  it("rejects openai realtime with a typed unsupported error (paid, no free verification)", async () => {
    const error = await createRealtimeToken({
      ...googleRoute,
      providerName: "openai",
      modelId: "gpt-realtime",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RealtimeTokenError);
    expect((error as RealtimeTokenError).errorCode).toBe("unsupported_provider");
    expect((error as RealtimeTokenError).providerName).toBe("openai");
    expect(String((error as Error).message)).toMatch(/not supported/i);
  });

  it("rejects fish-audio realtime the same way", async () => {
    const error = await createRealtimeToken({
      ...googleRoute,
      providerName: "fish-audio",
      modelId: "some-model",
    }).catch((e: unknown) => e);
    expect((error as RealtimeTokenError).errorCode).toBe("unsupported_provider");
    expect((error as RealtimeTokenError).providerName).toBe("fish-audio");
  });

  it("never touches the network for an unsupported provider", async () => {
    const fetchImpl = vi.fn();
    await expect(
      createRealtimeToken({ ...googleRoute, providerName: "openai" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(RealtimeTokenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
