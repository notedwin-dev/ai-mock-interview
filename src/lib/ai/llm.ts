import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import type { z } from "zod";

/**
 * LLM adapter for the agent-led creation flow (FR-SETUP-006; ADR-006 custom
 * pipeline). The route comes from the candidate's enabled LLM configuration
 * via resolveForOutboundCall; the exact provider model id is preserved and
 * never substituted. Credentials are decrypted only in that resolver and
 * live in memory just for this outbound call (ADR-0005).
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
  readonly code: "invalid_output" | "generation_failed";

  constructor(code: "invalid_output" | "generation_failed", message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

/** Official OpenAI-compatible provider (verified in AI SDK 7 docs). */
export function createRouteModel(route: LlmRoute): LanguageModel {
  return createOpenAICompatible({
    name: route.providerName,
    baseURL: route.baseUrl,
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
export const GENERATION_TIMEOUT_MS = 90_000;

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
