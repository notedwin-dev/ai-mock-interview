import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { UserProviderConfiguration } from "@/generated/prisma/client";
import { probeProviderConfiguration, discoverProviderModels, discoverCandidateModels, type ProbeDeps } from "./probe";
import { encryptApiKey } from "./encryption";

/**
 * Unit tests for the capability probe service (FR-PROVIDER-006). Network
 * access (fetchImpl) and persistence (save) are injected so tests are
 * hermetic and deterministic; each test describes one observable behaviour.
 */

process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");
process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "vtest";

const { envelope, encryptionKeyVersion } = encryptApiKey("sk-plaintext-secret");

const USER_ID = "22222222-2222-4222-8222-222222222222";
const CONFIG_ID = "11111111-1111-4111-8111-111111111111";

function jsonFetch(routes: Array<{ match: RegExp; status: number; body: unknown }>) {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes.find((candidate) => candidate.match.test(url));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function configRow(overrides: Partial<UserProviderConfiguration> = {}): UserProviderConfiguration {
  return {
    userProviderConfigurationId: CONFIG_ID,
    userId: USER_ID,
    providerType: "custom",
    providerName: "my-endpoint",
    baseUrl: "https://api.example.com/v1",
    encryptedApiKey: Buffer.from(envelope, "utf8"),
    encryptionKeyVersion,
    capabilitiesJson: { llm: { modelId: "test-model" } },
    credentialStatus: "unvalidated",
    isEnabled: true,
    configurationVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as UserProviderConfiguration;
}

/** Runs a probe with hermetic defaults; callers override one behaviour each. */
function runProbe(
  row: UserProviderConfiguration,
  fetchImpl: typeof fetch,
  extra: Partial<ProbeDeps> = {},
): ReturnType<typeof probeProviderConfiguration> {
  return probeProviderConfiguration(USER_ID, CONFIG_ID, {
    load: async () => row,
    fetchImpl,
    save: async () => {}, // no-op unless a test asserts on persistence
    ...extra,
  });
}

describe("probeProviderConfiguration (FR-PROVIDER-006)", () => {
  it("validates an LLM capability when the model list and chat endpoint both succeed", async () => {
    const result = await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 200, body: { data: [{ id: "test-model" }, { id: "other-model" }] } },
      { match: /\/chat\/completions$/, status: 200, body: { id: "chatcmpl-ping" } },
    ]));

    expect(result.capabilities).toHaveLength(1);
    const llm = result.capabilities[0]!;
    expect(llm).toMatchObject({ capability: "llm", status: "validated" });
    expect(llm.endpointReachable).toBe(true);
    expect(llm.credentialValid).toBe(true);
    expect(llm.selectedModelAccepted).toBe(true);
    expect(result.credentialStatus).toBe("valid");
  });

  it("distinguishes an authentication rejection from an unreachable endpoint", async () => {
    const result = await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 401, body: { error: { message: "Invalid API key" } } },
    ]));
    expect(result.capabilities[0]).toMatchObject({
      status: "failed",
      errorCode: "authentication_failed",
      endpointReachable: true,
      credentialValid: false,
    });
    // A failed test never validates the configuration (FR-PROVIDER-006).
    expect(result.credentialStatus).toBe("invalid");
  });

  it("reports an unsupported model distinctly when the provider rejects it", async () => {
    const result = await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 200, body: { data: [{ id: "other-model" }] } },
      { match: /\/chat\/completions$/, status: 400, body: { error: { message: "The model `test-model` does not exist" } } },
    ]));
    expect(result.capabilities[0]).toMatchObject({
      status: "failed",
      errorCode: "model_unsupported",
      endpointReachable: true,
      credentialValid: true,
    });
    expect(result.credentialStatus).toBe("invalid");
  });

  it("still validates the capability when the provider has no model-list endpoint", async () => {
    const result = await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 404, body: { error: { message: "Not found" } } },
      { match: /\/chat\/completions$/, status: 200, body: { id: "chatcmpl-ping" } },
    ]));
    expect(result.capabilities[0]).toMatchObject({
      status: "validated",
      endpointReachable: true,
      credentialValid: true,
      modelsDiscovered: null,
      selectedModelAccepted: null,
    });
    expect(result.credentialStatus).toBe("valid");
  });

  it("fails closed on a private Base URL without attempting any connection", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      throw new Error("probe must not touch the network for a blocked URL");
    }) as typeof fetch;

    const result = await runProbe(configRow({ baseUrl: "http://127.0.0.1:8080/v1" }), fetchImpl);
    expect(fetchCalled).toBe(false);
    expect(result.capabilities[0]).toMatchObject({
      status: "failed",
      endpointReachable: false,
      credentialValid: false,
    });
    expect(result.credentialStatus).toBe("invalid");
  });

  it("reports presets without a registered probe wire as skipped and never validates them", async () => {
    // Every ADR-030 preset now has a native wire; an UNREGISTERED preset
    // name (registry drift vs stored data) must fail closed as skipped,
    // never be probed and never be silently "validated".
    const result = await runProbe(
      configRow({ providerType: "preset", providerName: "does-not-exist", baseUrl: null }),
      jsonFetch([]), // must not be called at all
    );
    expect(result.capabilities[0]).toMatchObject({
      capability: "llm",
      status: "skipped",
      endpointReachable: false,
      credentialValid: false,
    });
    // Skipped ≠ validated: the configuration stays unvalidated, never "valid".
    expect(result.credentialStatus).toBe("unvalidated");
  });

  it("validates realtime by minting a short-lived native session without touching chat wires", async () => {
    // The WS-probe/adapter fix: realtime is verified on its native wire with a
    // neutral session config — never a chat wire and never interview content.
    const realtimeToken = vi.fn(async () => ({ token: "auth_short", url: "wss://live.example" }));
    const result = await runProbe(
      configRow({ capabilitiesJson: { realtime: { modelId: "gemini-3.1-flash-live-preview" } } }),
      jsonFetch([]), // must not be called — realtime uses its own native wire
      { realtimeToken },
    );
    expect(result.capabilities[0]).toMatchObject({
      capability: "realtime",
      status: "validated",
      endpointReachable: true,
      credentialValid: true,
    });
    // Our neutral session config is still passed to the native minter.
    expect(realtimeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gemini-3.1-flash-live-preview",
        apiKey: "sk-plaintext-secret",
      }),
      expect.objectContaining({
        sessionConfig: expect.objectContaining({ instructions: expect.stringContaining("Connectivity probe") }),
      }),
    );
    expect(result.credentialStatus).toBe("valid");
  });

  it("validates ElevenLabs realtime via the native client-secret wire (no injected token)", async () => {
    const fetchImpl = jsonFetch([
      {
        match: /api\.elevenlabs\.io\/v1\/convai\/conversation\/client-secret/,
        status: 200,
        body: { client_secret: "sk_short_lived_secret" },
      },
    ]);
    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "elevenlabs",
        baseUrl: null,
        capabilitiesJson: { realtime: { modelId: "eleven_realtime_v1_mini" } },
      }),
      fetchImpl,
      {}, // no realtimeToken injection — the real minter must run
    );
    expect(result.capabilities[0]).toMatchObject({
      capability: "realtime",
      status: "validated",
      endpointReachable: true,
      credentialValid: true,
    });
    expect(result.credentialStatus).toBe("valid");
    expect(JSON.stringify(result)).not.toContain("sk-plaintext-secret");
  });

  it("fails realtime when the provider rejects the native session, without leaking the key", async () => {
    const result = await runProbe(
      configRow({ capabilitiesJson: { realtime: { modelId: "bad-model" } } }),
      jsonFetch([]),
      { realtimeToken: async () => { throw new Error("provider refused sk-plaintext-secret"); } },
    );
    expect(result.capabilities[0]).toMatchObject({ status: "failed", credentialValid: false });
    expect(JSON.stringify(result)).not.toContain("sk-plaintext-secret");
    expect(result.credentialStatus).toBe("invalid");
  });

  it("explains a rejected realtime API key instead of hiding the provider reason", async () => {
    const result = await runProbe(
      configRow({ capabilitiesJson: { realtime: { modelId: "gemini-3.8-live-extended-thinking" } } }),
      jsonFetch([]),
      {
        realtimeToken: async () => {
          throw new Error('Google realtime auth token request failed: 400 {"error":{"message":"API key not valid. Please pass a valid API key."}}');
        },
      },
    );
    expect(result.capabilities[0]).toMatchObject({
      status: "failed",
      errorCode: "authentication_failed",
      endpointReachable: true,
      detail: "The provider rejected the API key.",
    });
  });

  it("skips realtime even on a probeable preset while still validating the row's other capabilities", async () => {
    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "openai",
        baseUrl: null,
        capabilitiesJson: { llm: { modelId: "test-model" }, realtime: { modelId: "realtime-model" } },
      }),
      jsonFetch([
        { match: /\/models$/, status: 200, body: { data: [{ id: "test-model" }] } },
        { match: /\/chat\/completions$/, status: 200, body: { id: "chatcmpl-ping" } },
      ]),
    );
    const byCapability = new Map(result.capabilities.map((r) => [r.capability, r]));
    expect(byCapability.get("llm")).toMatchObject({ status: "validated" });
    expect(byCapability.get("realtime")).toMatchObject({ status: "skipped" });
    // A skipped capability keeps the whole row unvalidated (status-neutral).
    expect(result.credentialStatus).toBe("unvalidated");
  });

  it("probes every enabled capability and validates only when all pass", async () => {
    const result = await runProbe(
      configRow({ capabilitiesJson: { llm: { modelId: "test-model" }, scorer: { modelId: "test-model" } } }),
      jsonFetch([
        { match: /\/models$/, status: 200, body: { data: [{ id: "test-model" }] } },
        { match: /\/chat\/completions$/, status: 200, body: { id: "chatcmpl-ping" } },
      ]),
    );
    expect(result.capabilities.map((r) => r.capability)).toEqual(["llm", "scorer"]);
    expect(result.capabilities.every((r) => r.status === "validated")).toBe(true);
    expect(result.credentialStatus).toBe("valid");
  });

  it("persists the post-probe status: valid, invalid, or untouched when all skipped", async () => {
    const saved: Array<{ status: "valid" | "invalid"; disabled: boolean }> = [];
    const save = async (
      _configurationId: string,
      credentialStatus: "valid" | "invalid",
      disable: boolean,
    ) => {
      saved.push({ status: credentialStatus, disabled: disable });
    };

    // All validated → stored "valid".
    await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 200, body: { data: [{ id: "test-model" }] } },
      { match: /\/chat\/completions$/, status: 200, body: { id: "ping" } },
    ]), { save });
    expect(saved).toEqual([{ status: "valid", disabled: false }]);

    // A failure → stored "invalid".
    await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 401, body: {} },
    ]), { save });
    expect(saved).toEqual([
      { status: "valid", disabled: false },
      { status: "invalid", disabled: true },
    ]);

    // All skipped (preset with no registered probe wire) → no status write.
    await runProbe(
      configRow({ providerType: "preset", providerName: "does-not-exist", baseUrl: null }),
      jsonFetch([]),
      { save },
    );
    expect(saved).toEqual([
      { status: "valid", disabled: false },
      { status: "invalid", disabled: true },
    ]);
  });

  it("sends only synthetic ping content — never real interview material", async () => {
    const seenBodies: Array<{ url: string; method: string; body: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ?? null;
      seenBodies.push({ url, method: init?.method ?? "GET", body: body === null ? null : String(body) });
      const route = /\/models$/.test(url)
        ? { status: 200, body: { data: [{ id: "test-model" }] } }
        : { status: 200, body: { id: "ping" } };
      return new Response(JSON.stringify(route.body), { status: route.status });
    }) as typeof fetch;

    await runProbe(configRow(), captureFetch);

    const models = seenBodies.find((call) => /\/models$/.test(call.url))!;
    expect(models.method).toBe("GET");
    expect(models.body).toBeNull();

    const ping = seenBodies.find((call) => /\/chat\/completions$/.test(call.url))!;
    const parsed = JSON.parse(ping.body!) as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(parsed.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(parsed.max_tokens).toBe(1);
  });

  it("classifies a rate-limit rejection as rate_limited, not a provider failure", async () => {
    const result = await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 429, body: { error: { message: "Rate limit reached" } } },
    ]));
    expect(result.capabilities[0]).toMatchObject({
      status: "failed",
      errorCode: "rate_limited",
      endpointReachable: true,
      credentialValid: true, // 429 is not a credential rejection
    });
    expect(result.credentialStatus).toBe("invalid");
  });

  it("classifies a provider server error distinctly from client-side failures", async () => {
    const result = await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 200, body: { data: [{ id: "test-model" }] } },
      { match: /\/chat\/completions$/, status: 500, body: { error: { message: "Internal server error" } } },
    ]));
    expect(result.capabilities[0]).toMatchObject({
      status: "failed",
      errorCode: "provider_error",
      endpointReachable: true,
      // The key reached the provider's processing; the failure is the server's.
      credentialValid: true,
    });
    expect(result.credentialStatus).toBe("invalid");
  });

  it("probes the TTS capability against the speech endpoint, not the chat endpoint", async () => {
    const seen: string[] = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push(`${init?.method ?? "GET"} ${url}`);
      const body = /\/audio\/speech$/.test(url) ? new Uint8Array([1, 2, 3]) : { data: /\/models$/.test(url) ? [{ id: "tts-1" }] : { id: "ping" } };
      return new Response(JSON.stringify(body ?? {}), { status: 200 });
    }) as typeof fetch;

    const result = await runProbe(
      configRow({ capabilitiesJson: { tts: { modelId: "tts-1" } } }),
      captureFetch,
    );

    expect(seen.some((call) => /\/audio\/speech$/.test(call))).toBe(true);
    expect(seen.some((call) => /\/chat\/completions$/.test(call))).toBe(false);
    expect(result.capabilities[0]).toMatchObject({ capability: "tts", status: "validated" });
  });

  it("probes the ASR capability with a multipart audio ping against the transcription endpoint", async () => {
    let transcriptionForm: FormData | null = null;
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/audio\/transcriptions$/.test(url)) {
        transcriptionForm = init?.body instanceof FormData ? init.body : null;
        return new Response(JSON.stringify({ text: "ping" }), { status: 200 });
      }
      return new Response(JSON.stringify(/\/models$/.test(url) ? { data: [{ id: "whisper-1" }] } : { id: "ping" }), { status: 200 });
    }) as typeof fetch;

    const result = await runProbe(
      configRow({ capabilitiesJson: { asr: { modelId: "whisper-1" } } }),
      captureFetch,
    );

    expect(transcriptionForm).toBeInstanceOf(FormData);
    expect(transcriptionForm!.get("model")).toBe("whisper-1"); // the exact selected model
    const file = transcriptionForm!.get("file") as File | null;
    expect(file).toBeInstanceOf(File);
    expect(file!.type).toBe("audio/wav");
    const wavHead = Buffer.from(await file!.arrayBuffer()).subarray(0, 4).toString("ascii");
    expect(wavHead).toBe("RIFF"); // a real, synthesised audio ping — no real content
    expect(result.capabilities[0]).toMatchObject({ capability: "asr", status: "validated" });
    expect(result.credentialStatus).toBe("valid");
  });

  it("probes the fish-audio preset against its native TTS endpoint with the exact configured model header", async () => {
    const seen: Array<{ method: string; url: string; headers: Headers; body: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({
        method: init?.method ?? "GET",
        url,
        headers: new Headers(init?.headers ?? undefined),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (/\/v1\/tts$/.test(url)) {
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 200 }); // audio bytes
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "fish-audio",
        baseUrl: null,
        capabilitiesJson: { tts: { modelId: "s2.1-pro-free" } },
      }),
      captureFetch,
    );

    // Exactly one network call: the native TTS ping. No OpenAI-shaped
    // model-list request (fish-audio has none — `GET /model` lists voices).
    expect(seen).toHaveLength(1);
    const ping = seen[0]!;
    expect(ping.url).toBe("https://api.fish.audio/v1/tts");
    expect(ping.method).toBe("POST");
    expect(ping.headers.get("authorization")).toBe("Bearer sk-plaintext-secret");
    // The exact configured model id must travel in the `model` header: Fish
    // serves the PAID s2.1-pro when the header is omitted.
    expect(ping.headers.get("model")).toBe("s2.1-pro-free");
    expect(JSON.parse(ping.body!)).toEqual({ text: "ping", format: "mp3" });
    expect(result.capabilities[0]).toMatchObject({
      capability: "tts",
      status: "validated",
      endpointReachable: true,
      credentialValid: true,
      // Without a model list the ping cannot independently certify the exact
      // model beyond the header itself, so the claim stays null, not true.
      modelsDiscovered: null,
      selectedModelAccepted: null,
    });
    expect(result.credentialStatus).toBe("valid");
  });

  it("probes a custom row pointing at fish.audio on the native TTS wire, matching the runtime", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({
        url,
        headers: new Headers(init?.headers ?? undefined),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (/\/v1\/tts$/.test(url)) {
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "custom",
        providerName: "fish-byok",
        baseUrl: "https://api.fish.audio",
        capabilitiesJson: { tts: { modelId: "s2.1-pro-free" } },
      }),
      captureFetch,
    );

    // The runtime TTS adapter routes fish.audio URLs to POST /v1/tts with the
    // `model` header — the probe must validate the SAME wire it certifies.
    expect(seen).toHaveLength(1);
    const ping = seen[0]!;
    expect(ping.url).toBe("https://api.fish.audio/v1/tts");
    expect(ping.headers.get("model")).toBe("s2.1-pro-free");
    expect(JSON.parse(ping.body!)).toEqual({ text: "ping", format: "mp3" });
    expect(result.capabilities[0]).toMatchObject({ status: "validated" });
    expect(result.credentialStatus).toBe("valid");
  });

  it("probes a custom row on a non-fish host with the OpenAI-shaped TTS wire", async () => {
    const seen: string[] = [];
    const captureFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push(url);
      const body = /\/audio\/speech$/.test(url)
        ? new Uint8Array([1, 2, 3])
        : { data: /\/models$/.test(url) ? [{ id: "tts-1" }] : { id: "ping" } };
      return new Response(JSON.stringify(body ?? {}), { status: 200 });
    }) as typeof fetch;

    const result = await runProbe(
      configRow({ baseUrl: "https://tts.example.com/v1", capabilitiesJson: { tts: { modelId: "tts-1" } } }),
      captureFetch,
    );

    expect(seen).toContain("https://tts.example.com/v1/audio/speech");
    expect(seen.some((url) => /\/v1\/tts$/.test(url))).toBe(false);
    expect(result.capabilities[0]).toMatchObject({ status: "validated" });
  });

  it("classifies a payment-required rejection (402) in the quota family, not as an auth failure", async () => {
    const result = await runProbe(configRow(), jsonFetch([
      { match: /\/models$/, status: 200, body: { data: [{ id: "test-model" }] } },
      { match: /\/chat\/completions$/, status: 402, body: { error: { message: "Insufficient credit" } } },
    ]));
    expect(result.capabilities[0]).toMatchObject({
      status: "failed",
      errorCode: "rate_limited",
      endpointReachable: true,
      // The key authenticated; the account merely lacks credit/quota.
      credentialValid: true,
    });
    expect(result.capabilities[0]!.detail).toMatch(/credit|payment/i);
    expect(result.credentialStatus).toBe("invalid");
  });

  it("classifies a fish-audio credit rejection the same way when its native TTS endpoint returns 402", async () => {
    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "fish-audio",
        baseUrl: null,
        capabilitiesJson: { tts: { modelId: "s2.1-pro-free" } },
      }),
      jsonFetch([{ match: /\/v1\/tts$/, status: 402, body: { message: "No credit" } }]),
    );
    expect(result.capabilities[0]).toMatchObject({
      capability: "tts",
      status: "failed",
      errorCode: "rate_limited",
      endpointReachable: true,
      credentialValid: true,
    });
    expect(result.capabilities[0]!.detail).toMatch(/credit|payment/i);
    expect(result.credentialStatus).toBe("invalid");
  });

  it("probes the google preset ASR on the native interactions wire (x-goog-api-key, models/ shape)", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({
        url,
        headers: new Headers(init?.headers ?? undefined),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (/\/v1beta\/interactions$/.test(url)) {
        return new Response(JSON.stringify({ output_text: "ping" }), { status: 200 });
      }
      if (/\/v1beta\/models$/.test(url)) {
        return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.5-transcribe" }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "google",
        baseUrl: null,
        capabilitiesJson: { asr: { modelId: "gemini-3.5-transcribe" } },
      }),
      captureFetch,
    );

    // The list call and the capability call use different credential forms on
    // the SAME base — the exact wire the runtime ASR adapter speaks.
    expect(seen.map((call) => call.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models",
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    ]);
    const ping = seen[1]!;
    expect(ping.headers.get("x-goog-api-key")).toBe("sk-plaintext-secret");
    expect(ping.headers.get("authorization")).toBeNull();
    const parsed = JSON.parse(ping.body!) as {
      model: string;
      input: Array<{ type: string; data: string; mime_type: string }>;
    };
    expect(parsed.model).toBe("models/gemini-3.5-transcribe");
    expect(parsed.input).toHaveLength(1);
    expect(parsed.input[0]!.mime_type).toBe("audio/wav");
    // The inline audio is the synthesised probe WAV, never real content.
    const wavHead = Buffer.from(parseBase64WavHead(parsed.input[0]!.data)).subarray(0, 4).toString("ascii");
    expect(wavHead).toBe("RIFF");
    expect(result.capabilities[0]).toMatchObject({
      capability: "asr",
      status: "validated",
      modelsDiscovered: ["gemini-3.5-transcribe"],
      selectedModelAccepted: true,
    });
    expect(result.credentialStatus).toBe("valid");
  });

  it("probes google LLM/scorer on the OpenAI-compatible /v1beta/openai surface with Bearer auth", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({ url, auth: new Headers(init?.headers ?? undefined).get("authorization") });
      if (/\/v1beta\/openai\/chat\/completions$/.test(url)) {
        return new Response(JSON.stringify({ id: "chatcmpl-ping" }), { status: 200 });
      }
      if (/\/v1beta\/models$/.test(url)) {
        return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.6-flash" }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "google",
        baseUrl: null,
        capabilitiesJson: { llm: { modelId: "gemini-3.6-flash" }, scorer: { modelId: "gemini-3.6-flash" } },
      }),
      captureFetch,
    );

    // The model list stays on the native wire (one call per capability, the
    // probe has no cross-capability cache); the chat pings move to the
    // documented OpenAI-compatible base with Bearer auth.
    expect(seen).toEqual([
      { url: "https://generativelanguage.googleapis.com/v1beta/models", auth: null },
      { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", auth: "Bearer sk-plaintext-secret" },
      { url: "https://generativelanguage.googleapis.com/v1beta/models", auth: null },
      { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", auth: "Bearer sk-plaintext-secret" },
    ]);
    expect(result.capabilities.map((r) => r.capability)).toEqual(["llm", "scorer"]);
    expect(result.capabilities.every((r) => r.status === "validated")).toBe(true);
    expect(result.capabilities.every((r) => r.selectedModelAccepted === true)).toBe(true);
    expect(result.credentialStatus).toBe("valid");
  });

  it("probes the google TTS preset on the native interactions wire with the audio output format", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({
        url,
        headers: new Headers(init?.headers ?? undefined),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (/\/v1beta\/interactions$/.test(url)) {
        return new Response(
          JSON.stringify({
            steps: [{ type: "model_output", content: [{ type: "audio", data: Buffer.from([1, 2, 3]).toString("base64") }] }],
          }),
          { status: 200 },
        );
      }
      if (/\/v1beta\/models$/.test(url)) {
        return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.8-flash-tts" }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "google",
        baseUrl: null,
        capabilitiesJson: { tts: { modelId: "gemini-3.8-flash-tts" } },
      }),
      captureFetch,
    );

    // No /audio/speech, no chat wire: Gemini TTS runs on the Interactions API
    // (x-goog-api-key) with the exact configured model id preserved.
    expect(seen.map((call) => call.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models",
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    ]);
    const ping = seen[1]!;
    expect(ping.headers.get("x-goog-api-key")).toBe("sk-plaintext-secret");
    const parsed = JSON.parse(ping.body!) as {
      model: string;
      input: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
      response_format: { type: string };
    };
    expect(parsed.model).toBe("gemini-3.8-flash-tts");
    expect(parsed.input[0]!.content[0]!.text).toBe("ping"); // synthetic ping only
    expect(parsed.response_format).toEqual({ type: "audio" });
    expect(result.capabilities[0]).toMatchObject({
      capability: "tts",
      status: "validated",
      selectedModelAccepted: true,
    });
    expect(result.credentialStatus).toBe("valid");
  });

  it("probes the anthropic preset on the native Messages wire (x-api-key + anthropic-version)", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({
        url,
        headers: new Headers(init?.headers ?? undefined),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (/\/models$/.test(url)) {
        // Anthropic has no model-list endpoint: 404 is "when supported".
        return new Response(JSON.stringify({ error: { type: "not_found_error" } }), { status: 404 });
      }
      if (/\/v1\/messages$/.test(url)) {
        return new Response(JSON.stringify({ id: "msg_ping", type: "message" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "anthropic",
        baseUrl: null,
        capabilitiesJson: { llm: { modelId: "claude-opus-5-5" }, scorer: { modelId: "claude-opus-5-5" } },
      }),
      captureFetch,
    );

    // llm and scorer each run their own list + ping (no cross-capability
    // cache); the list is absent (404 → "when supported"), the ping is on the
    // native Messages wire with x-api-key + anthropic-version.
    expect(seen.map((call) => call.url)).toEqual([
      "https://api.anthropic.com/models",
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/models",
      "https://api.anthropic.com/v1/messages",
    ]);
    const ping = seen[1]!;
    expect(ping.headers.get("x-api-key")).toBe("sk-plaintext-secret");
    expect(ping.headers.get("authorization")).toBeNull();
    expect(ping.headers.get("anthropic-version")).toBe("2023-06-01");
    const parsed = JSON.parse(ping.body!) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsed).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    // No list endpoint → modelsDiscovered stays null and the claim does not
    // overclaim, while the row still validates end to end.
    expect(result.capabilities.every((r) => r.status === "validated")).toBe(true);
    expect(result.capabilities.every((r) => r.modelsDiscovered === null)).toBe(true);
    expect(result.capabilities.every((r) => r.selectedModelAccepted === null)).toBe(true);
    expect(result.credentialStatus).toBe("valid");
  });

  it("maps anthropic error statuses into the probe taxonomy (401 auth, 404 model, 429 rate limit)", async () => {
    const runWithStatus = (status: number, body: unknown) =>
      runProbe(
        configRow({
          providerType: "preset",
          providerName: "anthropic",
          baseUrl: null,
          capabilitiesJson: { llm: { modelId: "claude-opus-5-5" } },
        }),
        jsonFetch([
          { match: /\/models$/, status: 404, body: {} },
          { match: /\/v1\/messages$/, status, body },
        ]),
      );

    const auth = await runWithStatus(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    expect(auth.capabilities[0]).toMatchObject({ status: "failed", errorCode: "authentication_failed", credentialValid: false });
    expect(JSON.stringify(auth)).not.toContain("sk-plaintext-secret");

    const missing = await runWithStatus(404, { type: "error", error: { type: "not_found_error", message: "model:claude-nope" } });
    // Anthropic's /v1/messages endpoint always exists — a 404 there is an
    // unknown model, mapped to model_unsupported (not endpoint_not_found).
    expect(missing.capabilities[0]).toMatchObject({ status: "failed", errorCode: "model_unsupported", credentialValid: true });

    const throttled = await runWithStatus(429, { type: "error", error: { type: "rate_limit_error", message: "over" } });
    expect(throttled.capabilities[0]).toMatchObject({ status: "failed", errorCode: "rate_limited", credentialValid: true });

    for (const result of [auth, missing, throttled]) {
      expect(result.credentialStatus).toBe("invalid");
    }
  });

  it("probes the elevenlabs preset TTS on the native /v1/text-to-speech/{model_id} wire (xi-api-key)", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({
        url,
        headers: new Headers(init?.headers ?? undefined),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (/\/v1\/text-to-speech\/eleven_v4$/.test(url)) {
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 200 }); // audio bytes
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "elevenlabs",
        baseUrl: null,
        capabilitiesJson: { tts: { modelId: "eleven_v4" } },
      }),
      captureFetch,
    );

    // Exactly one network call on the native TTS wire: model id in the path,
    // xi-api-key credential, no model-list call, no OpenAI-shaped endpoint.
    expect(seen).toHaveLength(1);
    const ping = seen[0]!;
    expect(ping.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/eleven_v4");
    expect(ping.headers.get("xi-api-key")).toBe("sk-plaintext-secret");
    expect(ping.headers.get("authorization")).toBeNull();
    expect(JSON.parse(ping.body!)).toMatchObject({ text: "ping", model_id: "eleven_v4" });
    expect(result.capabilities[0]).toMatchObject({
      capability: "tts",
      status: "validated",
      modelsDiscovered: null,
      selectedModelAccepted: null,
    });
    expect(result.credentialStatus).toBe("valid");
  });

  it("probes the elevenlabs preset ASR on the native /v1/speech-to-text wire with the synthesised WAV", async () => {
    let sttForm: FormData | null = null;
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/v1\/speech-to-text$/.test(url)) {
        sttForm = init?.body instanceof FormData ? init.body : null;
        return new Response(JSON.stringify({ text: "ping" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "elevenlabs",
        baseUrl: null,
        capabilitiesJson: { asr: { modelId: "scribe_v2" } },
      }),
      captureFetch,
    );

    expect(sttForm).toBeInstanceOf(FormData);
    expect(sttForm!.get("model_id")).toBe("scribe_v2"); // exact selected model
    const file = sttForm!.get("audio") as File | null;
    expect(file).toBeInstanceOf(File);
    const wavHead = Buffer.from(await file!.arrayBuffer()).subarray(0, 4).toString("ascii");
    expect(wavHead).toBe("RIFF");
    expect(result.capabilities[0]).toMatchObject({
      capability: "asr",
      status: "validated",
      modelsDiscovered: null,
      selectedModelAccepted: null,
    });
    expect(result.credentialStatus).toBe("valid");
  });

  it("validates the openai TTS preset on the OpenAI-compatible /audio/speech wire", async () => {
    const seen: Array<{ url: string; body: string | null }> = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({ url, body: typeof init?.body === "string" ? init.body : null });
      const body = /\/audio\/speech$/.test(url)
        ? new Uint8Array([1, 2, 3])
        : { data: /\/models$/.test(url) ? [{ id: "gpt-4o-mini-tts" }] : { id: "ping" } };
      return new Response(JSON.stringify(body ?? {}), { status: 200 });
    }) as typeof fetch;

    const result = await runProbe(
      configRow({
        providerType: "preset",
        providerName: "openai",
        baseUrl: null,
        capabilitiesJson: { tts: { modelId: "gpt-4o-mini-tts" } },
      }),
      captureFetch,
    );

    expect(seen.map((call) => call.url)).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/audio/speech",
    ]);
    // The exact configured TTS model id rides the OpenAI-shaped body.
    const speech = seen.find((call) => /\/audio\/speech$/.test(call.url))!;
    expect(JSON.parse(speech.body!)).toMatchObject({ model: "gpt-4o-mini-tts", input: "ping" });
    expect(result.capabilities[0]).toMatchObject({
      capability: "tts",
      status: "validated",
      selectedModelAccepted: true,
    });
    expect(result.credentialStatus).toBe("valid");
  });
});

function parseBase64WavHead(base64: string): ArrayBuffer {
  const binary = Buffer.from(base64, "base64");
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
}

describe("discoverProviderModels (FR-PROVIDER-009)", () => {
  it("returns the provider's model list when the provider exposes one", async () => {
    const result = await discoverProviderModels(USER_ID, CONFIG_ID, {
      load: async () => configRow(),
      fetchImpl: jsonFetch([
        { match: /\/models$/, status: 200, body: { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] } },
      ]),
      cache: new Map(),
    });
    expect(result).toMatchObject({ ok: true, models: ["gpt-4o", "gpt-4o-mini"], source: "provider" });
  });

  it("serves repeated discovery from the in-memory cache until the TTL expires", async () => {
    let fetchCount = 0;
    let clock = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 });
    }) as typeof fetch;
    const deps = {
      load: async () => configRow(),
      fetchImpl,
      cache: new Map(), // fresh cache per test: no cross-test leakage
      now: () => clock,
    };

    await discoverProviderModels(USER_ID, CONFIG_ID, deps);
    const second = await discoverProviderModels(USER_ID, CONFIG_ID, deps);
    expect(second).toMatchObject({ ok: true, models: ["gpt-4o"], source: "cache" });
    expect(fetchCount).toBe(1);

    clock = 61_000; // 61 s later, in ms: past the 60 s TTL → refetch
    const third = await discoverProviderModels(USER_ID, CONFIG_ID, deps);
    expect(third).toMatchObject({ source: "provider" });
    expect(fetchCount).toBe(2);
  });

  it("treats a missing model-list endpoint as models:null, not a failure", async () => {
    const result = await discoverProviderModels(USER_ID, CONFIG_ID, {
      load: async () => configRow(),
      fetchImpl: jsonFetch([{ match: /\/models$/, status: 404, body: {} }]),
      cache: new Map(),
    });
    expect(result).toMatchObject({ ok: true, models: null, source: "provider" });
  });

  it("classifies a network failure during discovery as a taxonomy error, not a crash", async () => {
    const result = await discoverProviderModels(USER_ID, CONFIG_ID, {
      load: async () => configRow(),
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND api.example.com");
      }) as typeof fetch,
      cache: new Map(),
    });
    expect(result).toMatchObject({ ok: false, errorCode: "network_unreachable" });
  });

  it("resolves a preset row's registry Base URL so preset rows are discoverable", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seenUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 });
    }) as typeof fetch;

    const result = await discoverProviderModels(USER_ID, CONFIG_ID, {
      load: async () => configRow({ providerType: "preset", providerName: "openai", baseUrl: null }),
      fetchImpl,
      cache: new Map(),
    });

    expect(seenUrls).toEqual(["https://api.openai.com/v1/models"]);
    expect(result).toMatchObject({ ok: true, models: ["gpt-4o"], source: "provider" });
  });

  it("reports fish-audio's missing OpenAI-shaped model list as models:null via its registry Base URL", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seenUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404 });
    }) as typeof fetch;

    const result = await discoverProviderModels(USER_ID, CONFIG_ID, {
      load: async () => configRow({ providerType: "preset", providerName: "fish-audio", baseUrl: null }),
      fetchImpl,
      cache: new Map(),
    });

    expect(seenUrls).toEqual(["https://api.fish.audio/models"]);
    expect(result).toMatchObject({ ok: true, models: null, source: "provider" });
  });

  it("lists a stored google row through Google's native list wire (x-goog-api-key, models/ prefix stripped)", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seenUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.6-flash" }] }), { status: 200 });
    }) as typeof fetch;

    const result = await discoverProviderModels(USER_ID, CONFIG_ID, {
      load: async () => configRow({ providerType: "preset", providerName: "google", baseUrl: null }),
      fetchImpl,
      cache: new Map(),
    });
    expect(seenUrls).toEqual(["https://generativelanguage.googleapis.com/v1beta/models"]);
    expect(result).toMatchObject({ ok: true, models: ["gemini-3.6-flash"], source: "provider" });
  });
});

describe("discoverCandidateModels (FR-PROVIDER-009, transient pre-create discovery)", () => {
  const candidateInput = {
    providerType: "preset" as const,
    providerName: "openai",
    apiKey: "sk-candidate-key",
  };

  it("lists a preset's models from its documented endpoint without persisting anything", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({ url, auth: new Headers(init?.headers ?? undefined).get("authorization") });
      return new Response(JSON.stringify({ data: [{ id: "gpt-6-luna" }] }), { status: 200 });
    }) as typeof fetch;

    const result = await discoverCandidateModels(candidateInput, { fetchImpl });
    expect(seen).toEqual([{ url: "https://api.openai.com/v1/models", auth: "Bearer sk-candidate-key" }]);
    expect(result).toMatchObject({ ok: true, models: ["gpt-6-luna"], source: "provider" });
  });

  it("classifies a rejected candidate key in the probe taxonomy", async () => {
    const result = await discoverCandidateModels(candidateInput, {
      fetchImpl: jsonFetch([{ match: /\/models$/, status: 401, body: {} }]),
    });
    expect(result).toMatchObject({ ok: false, errorCode: "authentication_failed" });
  });

  it("rejects an invalid candidate target before any network call", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      throw new Error("must not fetch");
    }) as typeof fetch;
    await expect(
      discoverCandidateModels({ providerType: "preset", providerName: "does-not-exist", apiKey: "k" }, { fetchImpl }),
    ).rejects.toMatchObject({ code: "unknown_preset" });
    await expect(
      discoverCandidateModels(
        { providerType: "preset", providerName: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      discoverCandidateModels(
        { providerType: "custom", providerName: "openai", baseUrl: "https://x.example.com", apiKey: "k" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "reserved_preset_name" });
    await expect(
      discoverCandidateModels(
        { providerType: "custom", providerName: "gw", baseUrl: "http://127.0.0.1:8080", apiKey: "k" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "invalid_base_url" });
    expect(fetchCalled).toBe(false);
  });

  it("speaks Google's native list wire for the google preset (x-goog-api-key, models/ prefix stripped)", async () => {
    const seen: Array<{ url: string; keyHeader: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({ url, keyHeader: new Headers(init?.headers ?? undefined).get("x-goog-api-key") });
      return new Response(
        JSON.stringify({ models: [{ name: "models/gemini-3.6-flash" }, { name: "gemini-3.5-transcribe" }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await discoverCandidateModels(
      { providerType: "preset", providerName: "google", apiKey: "g-key" },
      { fetchImpl },
    );
    expect(seen).toEqual([
      { url: "https://generativelanguage.googleapis.com/v1beta/models", keyHeader: "g-key" },
    ]);
    expect(result).toMatchObject({
      ok: true,
      models: ["gemini-3.6-flash", "gemini-3.5-transcribe"],
      source: "provider",
    });
  });
});
