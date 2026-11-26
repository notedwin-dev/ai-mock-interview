import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import { z } from "zod";
import { createRouteModel, generateStructured, LlmError } from "./llm";

const compatMock = vi.hoisted(() => ({ createOpenAICompatible: vi.fn() }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: compatMock.createOpenAICompatible }));

/**
 * Hermetic tests for the LLM adapter (backlog slice 25). The external
 * provider is replaced at the adapter's public injection seams — the AI SDK's
 * own mock language model for behaviour, a mocked factory for the
 * provider-construction contract; no network, no real credentials.
 */
const route: ProviderRoute = {
  providerName: "openai",
  providerType: "preset",
  baseUrl: "https://api.example.com/v1",
  modelId: "the-exact-configured-model",
  apiKey: "sk-super-secret",
};

const schema = z.object({ topic: z.string() });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRouteModel", () => {
  // The structured-output gate is a declared-capability rule (fail closed):
  // only the google preset may be told to send a full json_schema; every
  // other preset and every custom gateway gets the json_object wire.
  const cases: Array<[Partial<ProviderRoute>, boolean]> = [
    [{ providerName: "google", providerType: "preset" }, true],
    [{ providerName: "deepseek", providerType: "preset" }, false],
    [{ providerName: "zai-glm", providerType: "preset" }, false],
    [{ providerName: "qwen", providerType: "preset" }, false],
    [{ providerName: "my-gateway", providerType: "custom" }, false],
  ];
  it.each(cases)("structured-output flag for %j: %s", (overrides, expected) => {
    compatMock.createOpenAICompatible.mockReturnValue({ chatModel: vi.fn() });

    createRouteModel({ ...route, ...overrides });

    expect(compatMock.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        name: overrides.providerName,
        baseURL: route.baseUrl,
        apiKey: route.apiKey,
        supportsStructuredOutputs: expected,
      }),
    );
  });
});

describe("generateStructured", () => {
  it("aborts a stalled generation at the 90 s bound and reports generation_failed", async () => {
    // The SDK derives its abort signal from the timeout via
    // AbortSignal.timeout(ms) (mergeAbortSignals). Under vitest fake timers
    // the native signal is not faked, so the spy substitutes a timer-driven
    // signal for the same timeout value — the code under test still calls
    // generateText with `timeout: 90_000`, so this exercises the real bound
    // end-to-end (request → abort → typed error), not an exported constant.
    vi.useFakeTimers();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
        return controller.signal;
      });

    // A provider that never responds: doGenerate hangs until it is aborted.
    const model = new MockLanguageModelV4({
      provider: "openai",
      modelId: route.modelId,
      doGenerate: async (options) => {
        const signal = options.abortSignal;
        if (!signal) throw new Error("test requires an abort signal");
        if (signal.aborted) throw signal.reason;
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("doGenerate must not resolve before the abort");
      },
    });

    const settled = generateStructured(
      route,
      { schema, instructions: "Classify.", prompt: "Pick a topic" },
      { createModel: () => model },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await vi.advanceTimersByTimeAsync(90_000);
    const outcome = await settled;

    // The bound the SDK received is exactly the private 90 s constant.
    expect(timeoutSpy).toHaveBeenCalledWith(90_000);
    if (outcome.ok) throw new Error("the stalled generation must reject, not resolve");
    expect(outcome.error).toBeInstanceOf(LlmError);
    expect((outcome.error as LlmError).code).toBe("generation_failed");
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
        { createModel: () => model, },
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
