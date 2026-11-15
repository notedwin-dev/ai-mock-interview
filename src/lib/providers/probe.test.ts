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
});
