import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UserProviderConfiguration } from "@/generated/prisma/client";
import { probeProviderConfiguration, discoverProviderModels, type ProbeDeps } from "./probe";
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

  it("reports non-OpenAI presets as skipped and never validates them (M2 adapters)", async () => {
    const result = await runProbe(
      configRow({ providerType: "preset", providerName: "anthropic", baseUrl: null }),
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

  it("reports the realtime capability skipped and never touches any wire (native realtime protocol)", async () => {
    const result = await runProbe(
      configRow({ capabilitiesJson: { realtime: { modelId: "realtime-model" } } }),
      jsonFetch([]), // must not be called at all — realtime never hits these wires
    );
    expect(result.capabilities[0]).toMatchObject({
      capability: "realtime",
      status: "skipped",
      endpointReachable: false,
      credentialValid: false,
    });
    // Skipped ≠ validated: the configuration stays unvalidated, never "valid".
    expect(result.credentialStatus).toBe("unvalidated");
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

    // All skipped (M2-adapter preset) → no status write.
    await runProbe(
      configRow({ providerType: "preset", providerName: "anthropic", baseUrl: null }),
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
});

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
});
