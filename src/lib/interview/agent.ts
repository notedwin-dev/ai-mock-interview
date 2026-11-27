import { generateStructured, type StructuredOptions } from "@/lib/ai/llm";
import { db } from "@/lib/db";
import { resolveForOutboundCall } from "@/lib/providers/config";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import { z } from "zod";
import {
  createInterviewSession,
  findExistingInterviewCreation,
  type SessionSummary,
} from "./service";
import type { InterviewSetupInput } from "./validation";

/**
 * AI Interview Agent (FR-SETUP-006; backlog slice 25). It gathers the
 * interview purpose, target role, job description context and evaluation
 * strictness conversationally, then produces a structured configuration that
 * the UI shows BEFORE auto-creating the interview. No manual setup form sits
 * between generation and creation.
 *
 * The agent is a pure turn service: it never writes to the database. Session
 * creation stays in the existing interview service so its provider-route
 * snapshot and fail-closed rules remain the single source of truth.
 */

export const AGENT_FIELDS = ["purpose", "jobRole", "jobDescription", "strictness"] as const;
export const AGENT_CATEGORIES = ["general", "technical", "behavioral"] as const;
export const AGENT_STRICTNESS = ["supportive", "balanced", "rigorous"] as const;

export const agentConfigSchema = z
  .object({
    purpose: z.string().trim().min(1).max(500),
    jobRole: z.string().trim().min(1).max(150),
    jobDescription: z.string().trim().max(8000).default(""),
    strictness: z.enum(AGENT_STRICTNESS),
    category: z.enum(AGENT_CATEGORIES),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const agentLlmOutputSchema = z
  .object({
    reply: z.string().trim().min(1).max(2000),
    missingFields: z.array(z.enum(AGENT_FIELDS)),
    config: agentConfigSchema.nullable(),
  })
  .strict();
export type AgentLlmOutput = z.infer<typeof agentLlmOutputSchema>;

export const agentTurnInputSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["agent", "candidate"]),
            content: z.string().trim().min(1).max(5000),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type AgentTurnInput = z.infer<typeof agentTurnInputSchema>;

export type AgentErrorCode =
  | "invalid_input"
  | "turn_limit"
  | "generation_failed"
  | "category_unavailable";

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

export interface AgentResult {
  reply: string;
  missingFields: AgentLlmOutput["missingFields"];
  config: AgentConfig | null;
  ready: boolean;
}

export interface AgentDeps {
  resolveRoute?: (userId: string) => Promise<ProviderRoute>;
  generate?: (
    route: ProviderRoute,
    options: StructuredOptions<AgentLlmOutput>,
  ) => Promise<AgentLlmOutput>;
}

async function defaultResolveRoute(userId: string): Promise<ProviderRoute> {
  return resolveForOutboundCall(userId, "llm");
}

/** Instructions encode only approved requirements — never invented fields. */
const AGENT_INSTRUCTIONS = [
  "You are the AIMIS AI Interview Agent. Gather interview requirements conversationally.",
  "Ask for the interview purpose, the target job role, the job description context, and the evaluation strictness.",
  "Evaluation strictness must be exactly one of Supportive, Balanced or Rigorous (return lowercase: supportive, balanced, rigorous).",
  "Choose the interview category from general, technical or behavioral based on the purpose and role.",
  "Set missingFields to every requirement not yet supplied by the candidate; reply with one short natural question or confirmation.",
  "Set config to null unless all four requirements are present. Resolve empty values by asking, never by inventing them.",
  "Always return a structured response matching the required schema.",
].join(" ");

export async function runAgentTurn(
  userId: string,
  input: unknown,
  deps: AgentDeps = {},
): Promise<AgentResult> {
  let parsed: AgentTurnInput;
  try {
    parsed = agentTurnInputSchema.parse(input);
  } catch (error) {
    throw new AgentError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid agent conversation.",
    );
  }

  const options: StructuredOptions<AgentLlmOutput> = {
    schema: agentLlmOutputSchema,
    instructions: AGENT_INSTRUCTIONS,
    prompt: parsed.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n"),
  };
  const route = await (deps.resolveRoute ?? defaultResolveRoute)(userId);
  const generate = deps.generate ?? generateStructured;
  const output = agentLlmOutputSchema.parse(await generate(route, options));

  // The model cannot bypass the gather phase: a config is only usable when
  // it explicitly reports that every required field has been supplied.
  const complete = output.missingFields.length === 0;
  return {
    reply: output.reply,
    missingFields: output.missingFields,
    config: complete ? output.config : null,
    ready: complete && output.config !== null,
  };
}

export const agentCreationInputSchema = z
  .object({
    config: agentConfigSchema,
    missingFields: z.array(z.enum(AGENT_FIELDS)),
    idempotencyKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{1,100}$/)
      .optional(),
  })
  .strict();

export interface AgentCreationDeps {
  findCategory?: (code: string) => Promise<{ categoryId: string } | null>;
  findExisting?: (
    userId: string,
    idempotencyKey: string,
  ) => Promise<SessionSummary | null>;
  createSession?: (
    userId: string,
    input: InterviewSetupInput,
    idempotencyKey?: string,
  ) => Promise<SessionSummary>;
}

/**
 * Auto-creates the interview from the generated configuration (FR-SETUP-006,
 * FR-SETUP-007, FR-INTERVIEW-001). There is no manual form in between: the
 * validated config maps straight onto the existing session creation service,
 * which snapshots the LLM route and fails closed when no valid provider is
 * configured. A config with outstanding fields is refused before any write.
 */
export async function createInterviewFromAgentConfig(
  userId: string,
  input: unknown,
  deps: AgentCreationDeps = {},
): Promise<SessionSummary> {
  let parsed: z.infer<typeof agentCreationInputSchema>;
  try {
    parsed = agentCreationInputSchema.parse(input);
  } catch (error) {
    throw new AgentError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid generated configuration.",
    );
  }
  if (parsed.missingFields.length > 0) {
    throw new AgentError(
      "invalid_input",
      "Complete every interview detail before creating the session.",
    );
  }

  const idempotencyKey = parsed.idempotencyKey?.trim() || undefined;
  // A retry must replay the original session even if its category has since
  // been deactivated: only requests that would create a NEW session need the
  // active-category check.
  if (idempotencyKey) {
    const findExisting = deps.findExisting ?? findExistingInterviewCreation;
    const existing = await findExisting(userId, idempotencyKey);
    if (existing) return existing;
  }

  const findCategory =
    deps.findCategory ??
    (async (code: string) =>
      db.interviewCategory.findFirst({
        where: { categoryCode: code, isActive: true },
        select: { categoryId: true },
      }));
  const category = await findCategory(parsed.config.category);
  if (!category) {
    throw new AgentError(
      "category_unavailable",
      "The selected interview category is not available.",
    );
  }

  const createSession = deps.createSession ?? createInterviewSession;
  // Strictness maps 1:1 to the approved evaluation mode vocabulary; the
  // runtime uses the custom pipeline (native realtime remains a later path).
  return createSession(userId, {
    jobRole: parsed.config.jobRole,
    jobDescription: parsed.config.jobDescription,
    categoryId: category.categoryId,
    evaluationMode: parsed.config.strictness,
    runtimeMode: "custom",
  }, idempotencyKey);
}
