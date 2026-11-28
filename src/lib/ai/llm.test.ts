import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

const compatMock = vi.hoisted(() => ({ createOpenAICompatible: vi.fn() }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: compatMock.createOpenAICompatible }));
import { createRouteModel, generateStructured, GENERATION_TIMEOUT_MS, LlmError, type LlmRoute } from "./llm";

/**
 * Hermetic tests for the LLM adapter (TT-26 provider dispatch). The external
 * provider is replaced at the adapter's public injection seam (the AI SDK's
 * own mock language model) or, for the native Anthropic wire, with a mock
 * global fetch — no network, no real credentials.
 */
const route: LlmRoute = {
  providerName: "openai",
  providerType: "preset",
  baseUrl: "https://api.example.com/v1",
  modelId: "the-exact-configured-model",
  apiKey: "sk-super-secret",
};

const anthropicRoute: LlmRoute = {
  providerName: "anthropic",
  providerType: "preset",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-sonnet-5-5",
  apiKey: "anthropic-secret-key",
};

const schema = z.object({ topic: z.string() });

function mockAnthropicFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("generateStructured", () => {
  it("declares structured-output support so the SDK sends a full json_schema", () => {
    compatMock.createOpenAICompatible.mockReturnValue({ chatModel: vi.fn(() => ({})) });

    createRouteModel(route);

    expect(compatMock.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: route.baseUrl,
        apiKey: route.apiKey,
        name: route.providerName,
        supportsStructuredOutputs: true,
      }),
    );
  });

  it("keeps provider generation bounded but long enough for reasoning models", () => {
    // A 30 s bound cut off a real free-tier reasoning model mid-response.
    expect(GENERATION_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(GENERATION_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("uses the exact configured route/model and returns schema-validated output", async () => {
    const seen: string[] = [];
    const model = new MockLanguageModelV4({
      provider: "openai",
      modelId: route.modelId,
      doGenerate: async (options) => {
        seen.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text", text: '{"topic":"dragons"}' }],
          finishReason: { unified: "stop", raw: "stop" },
          warnings: [],
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
            totalTokens: 2,
          },
        };
      },
    });
    const createModel = vi.fn(() => model);

    const output = await generateStructured(
      route,
      { schema, instructions: "You classify topics.", prompt: "Pick a topic" },
      { createModel },
    );

    expect(output).toEqual({ topic: "dragons" });
    // The saved model id is passed through verbatim — never substituted.
    expect(createModel).toHaveBeenCalledWith(route);
    expect(model.modelId).toBe("the-exact-configured-model");
    expect(seen).toHaveLength(1);
    // In SDK 7 the instructions are delivered as a system model message
    // alongside the prompt — both must reach the configured provider.
    expect(seen[0]).toContain("Pick a topic");
    expect(seen[0]).toContain("You classify topics.");
  });

  it("reports malformed provider output as invalid_output, never as a partial object", async () => {
    const model = new MockLanguageModelV4({
      provider: "openai",
      modelId: route.modelId,
      doGenerate: async () => ({
        content: [{ type: "text", text: '{"topic":123}' }],
        finishReason: { unified: "stop", raw: "stop" },
        warnings: [],
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
          totalTokens: 2,
        },
      }),
    });

    await expect(
      generateStructured(
        route,
        { schema, instructions: "Classify.", prompt: "Pick a topic" },
        { createModel: () => model },
      ),
    ).rejects.toMatchObject({ name: "LlmError", code: "invalid_output" });
  });

  it("surfaces provider failures as generation_failed without leaking the API key", async () => {
    const model = new MockLanguageModelV4({
      provider: "openai",
      modelId: route.modelId,
      doGenerate: async () => {
        throw new Error("provider refused sk-super-secret at https://secret.host");
      },
    });

    try {
      await generateStructured(
        route,
        { schema, instructions: "Classify.", prompt: "Pick a topic" },
        { createModel: () => model },
      );
      expect.unreachable("provider failure must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe("generation_failed");
      expect((error as Error).message).not.toContain("sk-super-secret");
      expect((error as Error).message).not.toContain("secret.host");
    }
  });
});

describe("createRouteModel dispatch", () => {
  it("google preset: rewrites the registry base to the live-verified /v1beta/openai root", () => {
    compatMock.createOpenAICompatible.mockReturnValue({ chatModel: vi.fn(() => ({})) });
    const googleRoute: LlmRoute = {
      providerName: "google",
      providerType: "preset",
      baseUrl: "https://generativelanguage.googleapis.com",
      modelId: "gemini-3.6-flash",
      apiKey: "goog-key",
    };

    createRouteModel(googleRoute);

    expect(compatMock.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
        name: "google",
        supportsStructuredOutputs: true,
      }),
    );
    // Model id is applied on the chat model, verbatim.
    const provider = compatMock.createOpenAICompatible.mock.results[0]!.value as {
      chatModel: ReturnType<typeof vi.fn>;
    };
    expect(provider.chatModel).toHaveBeenCalledWith("gemini-3.6-flash");
  });

  it("a custom row already on the /v1beta/openai base is not double-suffixed", () => {
    compatMock.createOpenAICompatible.mockReturnValue({ chatModel: vi.fn(() => ({})) });
    const customRoute: LlmRoute = {
      providerName: "gemini-openai",
      providerType: "custom",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      modelId: "gemini-3.6-flash",
      apiKey: "goog-key",
    };

    createRouteModel(customRoute);

    // Custom rows are not google-named: their own base is used as-is.
    expect(compatMock.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: customRoute.baseUrl }),
    );
  });

  it("anthropic preset: builds the native model without touching the OpenAI-compatible adapter", () => {
    compatMock.createOpenAICompatible.mockClear();
    const model = createRouteModel(anthropicRoute) as unknown as {
      provider: string;
      modelId: string;
      specificationVersion: string;
    };

    expect(model.provider).toBe("anthropic");
    expect(model.modelId).toBe("claude-sonnet-5-5");
    expect(model.specificationVersion).toBe("v4");
    expect(compatMock.createOpenAICompatible).not.toHaveBeenCalled();
  });
});

describe("anthropic native Messages wire", () => {
  it("POSTs /v1/messages with x-api-key + anthropic-version, the exact model and a system field", async () => {
    const { calls, restore } = mockAnthropicFetch({
      content: [{ type: "text", text: '{"topic":"dragons"}' }],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 7 },
    });

    const output = await generateStructured(
      anthropicRoute,
      { schema, instructions: "You classify topics.", prompt: "Pick a topic" },
    );
    restore();

    expect(output).toEqual({ topic: "dragons" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe("anthropic-secret-key");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    const body = JSON.parse(calls[0]!.body);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("Pick a topic");
    // Instructions (AI SDK 7 system model message) travel in the system field.
    expect(body.system).toContain("You classify topics.");
    // The schema is embedded as a JSON instruction (honest approximation —
    // not a provider tool), so the model is guided to the exact shape.
    expect(body.system).toContain('"topic"');
    // The key must never appear in the body.
    expect(calls[0]!.body).not.toContain("anthropic-secret-key");
  });

  it("maps a custom row pointing at api.anthropic.com to the native wire by host", async () => {
    const { calls, restore } = mockAnthropicFetch({
      content: [{ type: "text", text: '{"topic":"lions"}' }],
      stop_reason: "end_turn",
    });

    const hostRoute: LlmRoute = { ...anthropicRoute, providerType: "custom", providerName: "relay" };
    const output = await generateStructured(
      hostRoute,
      { schema, instructions: "Classify.", prompt: "Pick" },
    );
    restore();

    expect(output).toEqual({ topic: "lions" });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe("anthropic-secret-key");
  });

  it("reports malformed JSON as invalid_output", async () => {
    const { restore } = mockAnthropicFetch({
      content: [{ type: "text", text: "not json at all" }],
      stop_reason: "end_turn",
    });
    try {
      await generateStructured(
        anthropicRoute,
        { schema, instructions: "Classify.", prompt: "Pick" },
      );
      expect.unreachable("malformed output must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe("invalid_output");
    } finally {
      restore();
    }
  });

  it("surfaces provider HTTP failures as generation_failed without leaking the key", async () => {
    const { restore } = mockAnthropicFetch(
      { error: { message: "invalid x-api-key anthropic-secret-key" } },
      401,
    );
    try {
      await generateStructured(
        anthropicRoute,
        { schema, instructions: "Classify.", prompt: "Pick" },
      );
      expect.unreachable("provider failure must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe("generation_failed");
      expect((error as Error).message).not.toContain("anthropic-secret-key");
      expect((error as Error).message).not.toContain("api.anthropic.com");
    } finally {
      restore();
    }
  });

  it("fails closed with typed unsupported errors for tools and for streamed generation", async () => {
    const model = createRouteModel(anthropicRoute) as unknown as {
      doGenerate: (options: Record<string, unknown>) => Promise<unknown>;
      doStream: (options: Record<string, unknown>) => Promise<unknown>;
    };

    // doStream is never a silent fallback: it throws a typed error.
    await expect(model.doStream({ prompt: [] })).rejects.toMatchObject({
      name: "LlmError",
      code: "unsupported",
    });

    // Structured output expressed as provider tools has no faithful native
    // equivalent: the wire fails closed before any network call.
    const { calls, restore } = mockAnthropicFetch({ content: [], stop_reason: "end_turn" });
    try {
      await expect(
        model.doGenerate({
          prompt: [],
          tools: [{ type: "function", name: "emit", parameters: {} }],
        }),
      ).rejects.toMatchObject({ name: "LlmError", code: "unsupported" });
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
