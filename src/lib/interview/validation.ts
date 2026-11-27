import { z } from "zod";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/utils/constants";

/**
 * Interview setup and typed-turn contracts (FR-SETUP-001..005,
 * FR-INTERVIEW-001/004) mirrored onto schema v0.4 column limits:
 * job_role VARCHAR(150), evaluation_mode / runtime_mode CHECK domains,
 * conversation_message speaker/kind/input-mode domains and the
 * VARCHAR(100) idempotency key (NFR-REL-002 dedup index).
 *
 * Engineering-defined limits (flagged for owner review at the M2 room
 * slice): jobDescription ≤ 8000 chars, response text ≤ 5000 chars,
 * idempotency key charset. The DB does not constrain text length.
 */

export const EVALUATION_MODES = ["supportive", "balanced", "rigorous"] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];

export const RUNTIME_MODES = ["preset_realtime", "custom"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const evaluationModeSchema = z.enum(EVALUATION_MODES);
export const runtimeModeSchema = z.enum(RUNTIME_MODES);

export const interviewSetupSchema = z
  .object({
    jobRole: z
      .string()
      .trim()
      .min(1, "Target job role is required.")
      .max(150, "Target job role must be at most 150 characters."),
    jobDescription: z
      .string()
      .trim()
      .max(8000, "Job description must be at most 8000 characters.")
      .optional(),
    experienceLevel: z.string().trim().max(120).optional(),
    techStack: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
    questionCount: z.number().int().min(1).max(50).optional(),
    categoryId: z.uuid("Select a valid interview category."),
    evaluationMode: evaluationModeSchema,
    runtimeMode: runtimeModeSchema,
  })
  .strict();

export type InterviewSetupInput = z.infer<typeof interviewSetupSchema>;

/** M1 typed slice: text input only — voice arrives with the M2 voice loop. */
export const CANDIDATE_INPUT_MODES = ["text", "voice"] as const;

const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(IDEMPOTENCY_KEY_PATTERN, "Idempotency key must be 1-100 characters of letters, digits, dot, underscore, dash or colon.");

export const typedTurnSchema = z
  .object({
    contentText: z
      .string()
      .trim()
      .min(1, "The response must not be empty.")
      .max(5000, "The response must be at most 5000 characters."),
    inputMode: z.literal("text"),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

export type TypedTurnInput = z.infer<typeof typedTurnSchema>;
