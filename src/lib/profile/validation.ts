import { z } from "zod";

/**
 * Candidate profile contracts (FR-PROFILE-001..004). Shapes for the JSONB
 * career fields (skills/education/experience/portfolio links) are engineering
 * definitions — the data dictionary fixes only the JSONB columns. They are
 * deliberately minimal and will be revisited with the owner when the profile
 * UI is built (flagged in the slice report).
 *
 * Column limits mirrored from schema v0.4: display_name VARCHAR(100),
 * headline VARCHAR(160), target_role VARCHAR(150); visibility CHECK domain
 * ('private','public') with a column default of 'private' (FR-PROFILE-002).
 */

export const VISIBILITY_VALUES = ["private", "public"] as const;
export type ProfileVisibility = (typeof VISIBILITY_VALUES)[number];

export const profileVisibilitySchema = z.enum(VISIBILITY_VALUES);

/** Consent-version label stamped on every sharing decision (VARCHAR(50)). */
export const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,50}$/;

export const consentVersionSchema = z
  .string()
  .trim()
  .regex(
    CONSENT_VERSION_PATTERN,
    "Consent version must be 1-50 characters of letters, digits, dot, underscore or dash.",
  );

const skillSchema = z.string().trim().min(1).max(50);

const educationSchema = z.object({
  institution: z.string().trim().min(1).max(120),
  qualification: z.string().trim().min(1).max(120),
  /** Free-form period label, e.g. "2020-2024". */
  period: z.string().trim().max(60).optional(),
});

const experienceSchema = z.object({
  organisation: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  period: z.string().trim().max(60).optional(),
  summary: z.string().trim().max(500).optional(),
});

export const profileInputSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, "Display name is required.")
      .max(100, "Display name must be at most 100 characters."),
    headline: z.string().trim().max(160, "Headline must be at most 160 characters.").optional(),
    professionalSummary: z
      .string()
      .trim()
      .max(2000, "Professional summary must be at most 2000 characters.")
      .optional(),
    targetRole: z
      .string()
      .trim()
      .max(150, "Target role must be at most 150 characters.")
      .optional(),
    skills: z.array(skillSchema).max(30, "At most 30 skills.").default([]),
    education: z.array(educationSchema).max(15, "At most 15 education entries.").default([]),
    experience: z.array(experienceSchema).max(15, "At most 15 experience entries.").default([]),
    portfolioLinks: z
      .array(z.url("Portfolio links must be valid URLs.").max(500))
      .max(10, "At most 10 portfolio links.")
      .default([]),
  })
  .strict();

export type ProfileInput = z.infer<typeof profileInputSchema>;
