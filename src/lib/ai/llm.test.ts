import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

const compatMock = vi.hoisted(() => ({ createOpenAICompatible: vi.fn() }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: compatMock.createOpenAICompatible }));
import { generateStructured, GENERATION_TIMEOUT_MS, LlmError, type LlmRoute } from "./llm";

/**
 * Hermetic tests for the LLM adapter (backlog slice 25). The external
 * provider is replaced at the adapter's public injection seam with the
 * AI SDK's own mock language model — no network, no real credentials.
 */
const route: LlmRoute = {
  providerName: "openai",
  providerType: "preset",
  baseUrl: "https://api.example.com/v1",
  modelId: "the-exact-configured-model",
  apiKey: "sk-super-secret",
};

const schema = z.object({ topic: z.string() });

describe("generateStructured", () => {
  it("declares structured-output support so the SDK sends a full json_schema", async () => {
    const { createRouteModel } = await import("./llm");
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
