import { z } from "zod";

/**
 * Feature-scoped environment for authentication (docs/ENVIRONMENT.md).
 *
 * Parsed lazily on the first auth feature use (sign-in attempt) instead of at
 * module load, so `next build` and unit tests never require auth secrets to be
 * present. Session reads with a missing AUTH_SECRET fail earlier inside
 * Auth.js itself (MissingSecret), which is the backstop for that path.
 */
const authEnvSchema = z.object({
  AUTH_SECRET: z
    .string()
    .min(
      16,
      "AUTH_SECRET must be at least 16 characters. Generate one with: openssl rand -base64 32",
    ),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export function getAuthEnv(): AuthEnv {
  return authEnvSchema.parse({
    AUTH_SECRET: process.env["AUTH_SECRET"],
  });
}
