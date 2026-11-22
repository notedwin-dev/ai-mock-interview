/**
 * Public-profile projection (FR-PROFILE-003): the single recruiter-facing
 * allowlist point. Deliberately excludes professionalSummary and targetRole —
 * per the approved data model ("display name, headline, skills, education,
 * experience and portfolio links"), and interview data is never part of this
 * shape. Pure by design so the allowlist is unit-testable without a database.
 */

export interface ProfileSummary {
  displayName: string;
  headline: string | null;
  professionalSummary: string | null;
  targetRole: string | null;
  skills: string[];
  education: Array<{ institution: string; qualification: string; period?: string }>;
  experience: Array<{ organisation: string; role: string; period?: string; summary?: string }>;
  portfolioLinks: string[];
  visibility: string;
  updatedAt: string;
}

export interface PublicProfileProjection {
  displayName: string;
  headline: string | null;
  skills: string[];
  education: Array<{ institution: string; qualification: string; period?: string }>;
  experience: Array<{ organisation: string; role: string; period?: string; summary?: string }>;
  portfolioLinks: string[];
}

export function toPublicProjection(profile: ProfileSummary): PublicProfileProjection {
  return {
    displayName: profile.displayName,
    headline: profile.headline,
    skills: profile.skills,
    education: profile.education,
    experience: profile.experience,
    portfolioLinks: profile.portfolioLinks,
  };
}
