import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_VERSION_HEADER_NAME,
  GOOGLE_OPENAI_COMPAT_PATH,
  LLM_TIMEOUT_MS,
  X_API_KEY_HEADER,
} from "@/lib/utils/constants";

/**
 * LLM adapter for the agent-led creation flow, the live interview turns and
 * the consolidated scorer (FR-SETUP-006, FR-PROVIDER-003; ADR-006 custom
 * pipeline). The route comes from the candidate's enabled LLM/scorer
 * configuration via resolveForOutboundCall; the exact provider model id is
 * preserved and never substituted. Credentials are decrypted only in that
 * resolver and live in memory just for this outbound call (ADR-0005).
 *
 * Provider dispatch (ADR-030 register; TT-26):
 * - `anthropic` preset / api.anthropic.com base → the provider's native
 *   Messages wire (`POST {base}/v1/messages`, `x-api-key` +
 *   `anthropic-version: 2023-06-01`); an OpenAI-compatible adapter cannot
 *   speak that wire, so a native model is built here.
 * - `google` preset base → Google's documented OpenAI-compatible base
 *   `{base}/v1beta/openai` (the path live-verified in docs/FEASIBILITY.md),
 *   because the registry base `generativelanguage.googleapis.com` alone is
 *   not the OpenAI-compatible root.
 * - every other provider (openai, deepseek, zai-glm, qwen, custom
 *   OpenAI-compatible rows) → `createOpenAICompatible`, unchanged.
 *
 * The SCORER capability needs no separate adapter here: it is an LLM-shaped
 * structured-output call — resolveForOutboundCall(userId, "scorer") returns
 * the same route shape and callers drive it through generateStructured(), so
 * the dispatch above covers llm and scorer with one wire per provider.
 *
 * Provider construction and generation are injectable so hermetic tests can
 * use the AI SDK's own mock language model instead of a real provider.
 */
export interface LlmRoute {
  providerName: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export class LlmError extends Error {
  readonly code: "invalid_output" | "generation_failed" | "unsupported";

  constructor(code: "invalid_output" | "generation_failed" | "unsupported", message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

function isAnthropicRoute(route: LlmRoute): boolean {
  if (route.providerName.toLowerCase() === "anthropic") return true;
  try {
    return new URL(route.baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * Google preset rows carry the registry base
 * `https://generativelanguage.googleapis.com`; the OpenAI-compatible API
 * lives under its `/v1beta/openai` sub-root (docs/FEASIBILITY.md, live
 * verified). Custom rows already carry their own base and are used as-is.
 */
function googleOpenAiBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.includes(GOOGLE_OPENAI_COMPAT_PATH)) return base;
  return `${base}${GOOGLE_OPENAI_COMPAT_PATH}`;
}

/* ------------------------------------------------------------------ */
/* Anthropic native Messages wire                                       */
/* ------------------------------------------------------------------ */

/** Hard output ceiling for structured interview generations (tokens). */
const ANTHROPIC_MAX_TOKENS = 8192;
// The fixed API version and the hard request ceiling (still bounded,
// NFR-REL-002) are shared constants: `ANTHROPIC_API_VERSION` and
// `LLM_TIMEOUT_MS` from `@/lib/utils/constants`.

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** System instructions and one user prompt, in order. */
type AnthropicPrompt = {
  system?: string;
  user: string;
};

/** The structural shape of the AI SDK LanguageModelV4 this native model
 *  implements (non-streaming, tool-free). The `ai` package types models as a
 *  versioned union (`LanguageModel`), so the object literal is checked
 *  structurally against that union at the return site. */
type AnthropicNativeModel = {
  readonly specificationVersion: "v4";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]>;
  doGenerate(options: {
    prompt: readonly unknown[];
    maxOutputTokens?: number;
    responseFormat?: { type?: string; schema?: unknown; name?: string; description?: string };
    tools?: unknown[];
    abortSignal?: AbortSignal;
  }): Promise<{
    content: Array<{ type: "text"; text: string }>;
    finishReason: { unified: "stop" | "length"; raw: string };
    usage: {
      inputTokens: { total: number; noCache: number; cacheRead: undefined; cacheWrite: undefined };
      outputTokens: { total: number; text: number; reasoning: undefined };
      totalTokens: number;
    };
    warnings: Array<never>;
  }>;
  doStream(options: { prompt: readonly unknown[] }): Promise<never>;
};

/**
 * Maps the AI SDK V4 prompt (system model messages + user text parts) to the
 * Anthropic request shape: system messages concatenate into the `system`
 * field; the LAST user message carries the structured-output instructions and
 * the prompt text (AI SDK 7 delivers `instructions` as a leading system model
 * message and `prompt` as a trailing user message); earlier user messages
 * (conversation history) stay verbatim.
 */
function anthropicPrompt(prompt: readonly unknown[]): AnthropicPrompt {
  const system: string[] = [];
  const userMessages: string[] = [];
  for (const message of prompt) {
    const record = message as { role?: string; content?: unknown };
    if (record.role === "system") {
      if (typeof record.content === "string") system.push(record.content);
    } else if (record.role === "user" && Array.isArray(record.content)) {
      const text = (record.content as Array<{ type?: string; text?: string }>)
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .join("");
      userMessages.push(text);
    }
  }
  const user = userMessages.pop() ?? "";
  return {
    ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
    user,
  };
}

/** Strict JSON: no markdown fences, no prose around the object. */
const STRUCTURED_OUTPUT_INSTRUCTION =
  "Respond with ONE JSON object only. Do not wrap it in markdown fences and do not add any text before or after it. The object must match the schema.";

/** Throws a provider-shaped error with a fixed message (never the URL/key). */
function anthropicTransportError(): Error {
  return new Error("Anthropic request failed");
}

/**
 * A minimal AI SDK LanguageModelV4 over Anthropic's native Messages API.
 * Non-streaming only: the custom pipeline never streams LLM turns
 * (generateText), so doStream fails closed instead of silently pretending.
 *
 * Structured output: the AI SDK may express schema-constrained output as
 * `tools` + a forced tool choice (the OpenAI-compatible provider supports
 * that). The native Messages wire here has no schema-constrained object
 * mode, so `tools` are rejected with a typed unsupported error (fail closed
 * per NFR-REL-002 — never a silent, looser behaviour). Plain JSON mode
 * (responseFormat.type === "json") IS honoured.
 */
function createAnthropicModel(route: LlmRoute): AnthropicNativeModel {
  const base = route.baseUrl.replace(/\/+$/, "");
  const url = `${base}/v1/messages`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [X_API_KEY_HEADER]: route.apiKey,
    [ANTHROPIC_VERSION_HEADER_NAME]: ANTHROPIC_API_VERSION,
  };

  const assertNoTools = (options: { tools?: unknown[] }): void => {
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      throw new LlmError(
        "unsupported",
        "The configured provider does not support the requested structured-output tool mode.",
      );
    }
  };

  const run = async (options: {
    prompt: readonly unknown[];
    maxOutputTokens?: number;
    responseFormat?: { type?: string; schema?: unknown; name?: string; description?: string };
    tools?: unknown[];
    abortSignal?: AbortSignal;
  }) => {
    assertNoTools(options);
    const mapped = anthropicPrompt(options.prompt);
    const body: Record<string, unknown> = {
      model: route.modelId,
      max_tokens: options.maxOutputTokens ?? ANTHROPIC_MAX_TOKENS,
      messages: [{ role: "user", content: mapped.user }],
      stream: false,
    };
    // Structured output: AI SDK 7 delivers the zod-derived JSON schema via
    // responseFormat (plain JSON mode, not a provider tool). We embed the
    // schema in the instructions so the model is guided to the exact shape —
    // a documented, honest approximation, NOT the OpenAI-compatible
    // provider's strict json_schema guarantee. Invalid JSON still fails
    // closed downstream (invalid_output); there is no silent fallback.
    const schema = options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
    const instruction = schema !== undefined
      ? `${STRUCTURED_OUTPUT_INSTRUCTION}\nThe object must have exactly this JSON shape: ${JSON.stringify(schema)}`
      : STRUCTURED_OUTPUT_INSTRUCTION;
    body.system = mapped.system ? `${mapped.system}\n\n${instruction}` : instruction;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
    } catch {
      throw anthropicTransportError();
    }
    if (!response.ok) {
      // Drain to avoid socket leaks; the body is never forwarded (NFR-SEC-008).
      await response.text().catch(() => undefined);
      throw anthropicTransportError();
    }
    let parsed: AnthropicResponse;
    try {
      parsed = (await response.json()) as AnthropicResponse;
    } catch {
      throw anthropicTransportError();
    }

    const text = (parsed.content ?? [])
      .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
    return {
      content: text ? [{ type: "text" as const, text }] : [],
      finishReason:
        parsed.stop_reason === "max_tokens"
          ? ({ unified: "length", raw: parsed.stop_reason } as const)
          : ({ unified: "stop", raw: parsed.stop_reason ?? "stop" } as const),
      usage: {
        inputTokens: { total: parsed.usage?.input_tokens ?? 0, noCache: parsed.usage?.input_tokens ?? 0, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: parsed.usage?.output_tokens ?? 0, text: parsed.usage?.output_tokens ?? 0, reasoning: undefined },
        totalTokens: (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0),
      },
    };
  };

  return {
    specificationVersion: "v4",
    provider: "anthropic",
    modelId: route.modelId,
    supportedUrls: {},
    doGenerate: async (options) => {
      const result = await run(options);
      return { ...result, warnings: [] };
    },
    doStream: async () => {
      throw new LlmError(
        "unsupported",
        "The configured provider does not support streamed generation.",
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Route dispatch                                                       */
/* ------------------------------------------------------------------ */

export function createRouteModel(route: LlmRoute): LanguageModel {
  if (isAnthropicRoute(route)) {
    return createAnthropicModel(route);
  }
  const baseURL =
    route.providerName.toLowerCase() === "google" ? googleOpenAiBase(route.baseUrl) : route.baseUrl;
  return createOpenAICompatible({
    name: route.providerName,
    baseURL,
    apiKey: route.apiKey,
    // Approved runtime models must support structured output (ADR-006); this
    // makes the SDK send a full json_schema instead of loose json_object.
    supportsStructuredOutputs: true,
  }).chatModel(route.modelId);
}

export interface StructuredOptions<T> {
  schema: z.ZodType<T>;
  instructions: string;
  prompt: string;
}

export interface StructuredDeps {
  createModel?: (route: LlmRoute) => LanguageModel;
}

/**
 * Maximum wall-clock time for one generation (still bounded). 30 s cut off a
 * real free-tier reasoning model mid-response; 90 s leaves room for thinking
 * tokens without allowing an unbounded provider call.
 */
export const GENERATION_TIMEOUT_MS = LLM_TIMEOUT_MS;

export async function generateStructured<T>(
  route: LlmRoute,
  options: StructuredOptions<T>,
  deps: StructuredDeps = {},
): Promise<T> {
  const model = (deps.createModel ?? createRouteModel)(route);
  let output: T;
  try {
    const result = await generateText({
      model,
      instructions: options.instructions,
      prompt: options.prompt,
      output: Output.object({ schema: options.schema }),
      // Bounded attempts; a failed test never falls back to another model/provider.
      maxRetries: 0,
      timeout: GENERATION_TIMEOUT_MS,
      telemetry: { isEnabled: false },
    });
    output = result.output;
  } catch (error) {
    // Never forward provider error text to callers, logs or the UI: it can
    // contain request URLs, headers or credential fragments (NFR-SEC-008).
    if (error instanceof LlmError) throw error;
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new LlmError(
        "invalid_output",
        "The configured model returned output that does not match the required structure.",
      );
    }
    throw new LlmError(
      "generation_failed",
      "The configured provider could not generate a response.",
    );
  }
  // AI SDK validates against the schema too; re-parse at the boundary so the
  // rest of the system only sees values our own contract accepts.
  const parsed = options.schema.safeParse(output);
  if (!parsed.success) {
    throw new LlmError(
      "invalid_output",
      "The configured model returned output that does not match the required structure.",
    );
  }
  return parsed.data;
}
