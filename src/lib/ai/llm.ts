import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import type { z } from "zod";

/**
 * LLM adapter for the agent-led creation flow and the token-scoped room
 * (FR-SETUP-006, FR-INTERVIEW-003; ADR-006 custom pipeline). The route comes
 * from the candidate's enabled LLM configuration via resolveForOutboundCall;
 * the exact provider model id is preserved and never substituted.
 * Credentials are decrypted only in that resolver and live in memory just for
 * this outbound call (ADR-0005).
 *
 * Provider construction and generation are injectable so hermetic tests can
 * use the AI SDK's own mock language model instead of a real provider.
 */
export class LlmError extends Error {
  readonly code: "invalid_output" | "generation_failed";

  constructor(code: "invalid_output" | "generation_failed", message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

/**
 * Structured-output capability gate (FR-PROVIDER-006/008, fail closed):
 * `supportsStructuredOutputs` is declared only for the `google` preset, whose
 * OpenAI-compatible endpoint (verified against the provider's documented
 * API, 2026-11) supports `response_format` with a full `json_schema`. The
 * OpenAI wire and the other presets (deepseek, zai-glm, qwen) are only
 * guaranteed `json_object` mode, and custom OpenAI-compatible gateways make
 * no declared guarantee at all — declaring `json_schema` there would demand a
 * capability the gateway may not implement, so it is never claimed. When the
 * flag is false the SDK sends `response_format: { type: "json_object" }`,
 * which the documented OpenAI-compatible endpoints accept — no regression,
 * no invented capability (registry capability data for those providers is
 * owner-maintained and not yet in scope).
 */
function supportsStructuredOutputs(route: ProviderRoute): boolean {
  return route.providerType === "preset" && route.providerName === "google";
}

/** Official OpenAI-compatible provider (verified in AI SDK 7 docs). */
export function createRouteModel(route: ProviderRoute): LanguageModel {
  return createOpenAICompatible({
    name: route.providerName,
    baseURL: route.baseUrl,
    apiKey: route.apiKey,
    supportsStructuredOutputs: supportsStructuredOutputs(route),
  }).chatModel(route.modelId);
}

export interface StructuredOptions<T> {
  schema: z.ZodType<T>;
  instructions: string;
  prompt: string;
}

export interface StructuredDeps {
  createModel?: (route: ProviderRoute) => LanguageModel;
}

/**
 * Maximum wall-clock time for one generation (still bounded). 30 s cut off a
 * real free-tier reasoning model mid-response; 90 s leaves room for thinking
 * tokens without allowing an unbounded provider call. Private by design —
 * the bound is behaviour (a generation cannot outlive it), not an exported
 * constant for callers to special-case; the behaviour test fakes the clock.
 */
const GENERATION_TIMEOUT_MS = 90_000;

export async function generateStructured<T>(
  route: ProviderRoute,
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
