import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { LlmError } from "@/lib/ai/llm";
import { requireApiAccount } from "@/lib/auth/guard";
import {
  agentConfigSchema,
  AgentError,
  AGENT_FIELDS,
  createInterviewFromAgentConfig,
  runAgentTurn,
} from "@/lib/interview/agent";

/**
 * POST /api/v1/interviews/agent — the AI Interview Agent's server boundary
 * (FR-SETUP-006/007). "turn" runs one conversational generation with the
 * candidate's configured LLM; "create" auto-creates the interview from the
 * generated configuration. Both operations run server-side — the browser
 * never sees an API key or chooses a provider/model (ADR-0005, ADR-006).
 */
const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("turn"),
    messages: z
      .array(
        z
          .object({ role: z.enum(["agent", "candidate"]), content: z.string().trim().min(1).max(5000) })
          .strict(),
      )
      .min(1)
      .max(12),
  }),
  z.object({
    action: z.literal("create"),
    config: agentConfigSchema,
    missingFields: z.array(z.enum(AGENT_FIELDS)),
  }),
]);

function mapAgentError(error: unknown): Response {
  if (error instanceof LlmError) {
    // Provider error text can contain request URLs or credential fragments —
    // never forward it; the taxonomy alone is actionable for the UI.
    return jsonError(
      502,
      error.code === "invalid_output" ? "provider_invalid_output" : "provider_failed",
      "The configured provider could not complete this request. Check the configuration and try again.",
    );
  }
  if (error instanceof AgentError) {
    const status =
      error.code === "invalid_input"
        ? 400
        : error.code === "category_unavailable"
          ? 409
          : 502;
    return jsonError(status, error.code, error.message);
  }
  // ProviderConfigError / InterviewError keep their established envelopes
  // (e.g. provider_route_missing → 409) via the shared mapper.
  return errorResponse(error);
}

export async function POST(request: Request): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch {
    return jsonError(400, "invalid_input", "A valid agent action is required.");
  }

  try {
    if (body.action === "turn") {
      const result = await runAgentTurn(account.account.userId, { messages: body.messages });
      return Response.json({ result });
    }
    const session = await createInterviewFromAgentConfig(account.account.userId, {
      config: body.config,
      missingFields: body.missingFields,
    });
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    return mapAgentError(error);
  }
}
