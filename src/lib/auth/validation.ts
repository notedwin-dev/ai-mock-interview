import { z } from "zod";

/**
 * Roles that may be self-registered (FR-AUTH-001/004: exactly one role per
 * account). Administrators are provisioned out-of-band, never through the
 * public registration flow.
 */
export const SELF_SERVICE_ROLES = ["candidate", "recruiter"] as const;
export type SelfServiceRole = (typeof SELF_SERVICE_ROLES)[number];

/** Normalises before validating so stored emails are lowercase and trimmed. */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address."));

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128, "Password must be at most 128 characters.")
  .regex(/[A-Za-z]/, "Password must contain a letter.")
  .regex(/[0-9]/, "Password must contain a digit.");

const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display name is required.")
  .max(100, "Display name must be at most 100 characters.");

export const registrationSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  role: z.enum(SELF_SERVICE_ROLES),
});

/**
 * Sign-in accepts any non-empty password: the strength policy governs
 * registration, not authentication of pre-existing (legacy) hashes.
 */
export const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required."),
});

/** Shared state shape for the auth forms rendered via useActionState. */
export interface AuthFormState {
  error?: string;
}
