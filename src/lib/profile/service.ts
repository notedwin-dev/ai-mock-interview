import { z } from "zod";
import type { CandidateProfile, CandidateResume, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { resolveConsentWrite, type ConsentAction, type ConsentState } from "./consent";
import { toPublicProjection, type ProfileSummary, type PublicProfileProjection } from "./projection";
import {
  CONSENT_VERSION_PATTERN,
  profileInputSchema,
  profileVisibilitySchema,
  type ProfileInput,
  type ProfileVisibility,
} from "./validation";

/**
 * Candidate profile + resume consent service (approved component → module
 * home, docs/ARCHITECTURE.md §3). Profile rows are created on first save and
 * are private by default (FR-PROFILE-002). The public projection is the
 * single allowlist point for recruiter access (FR-PROFILE-003): everything
 * not listed there stays private, and this module is the only place that
 * builds it.
 *
 * Resume functions are storage-agnostic: they own consent state and metadata
 * only. File bytes go through src/lib/storage (slice 3b); deleting a row
 * returns the storage key so the caller can remove the file idempotently.
 */

export type ProfileErrorCode =
  | "not_found"
  | "invalid_input"
  | "profile_required";

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode, message: string) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

/** The candidate's own complete view (private fields included). */
export type { ProfileSummary, PublicProfileProjection } from "./projection";

function toSummary(row: CandidateProfile): ProfileSummary {
  return {
    displayName: row.displayName,
    headline: row.headline,
    professionalSummary: row.professionalSummary,
    targetRole: row.targetRole,
    skills: row.skillsJson as ProfileSummary["skills"],
    education: row.educationJson as ProfileSummary["education"],
    experience: row.experienceJson as ProfileSummary["experience"],
    portfolioLinks: row.portfolioLinksJson as ProfileSummary["portfolioLinks"],
    visibility: row.visibility as ProfileVisibility,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Resume metadata visible to its owner (consent state included). */
export interface ResumeSummary {
  resumeId: string;
  originalFileName: string;
  mimeType: string;
  fileSizeBytes: number;
  isSharedWithRecruiters: boolean;
  sharingConsentedAt: string | null;
  sharingConsentVersion: string | null;
  sharingRevokedAt: string | null;
  createdAt: string;
}

function toResumeSummary(row: CandidateResume): ResumeSummary {
  return {
    resumeId: row.resumeId,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    fileSizeBytes: Number(row.fileSizeBytes),
    isSharedWithRecruiters: row.isSharedWithRecruiters,
    sharingConsentedAt: row.sharingConsentedAt?.toISOString() ?? null,
    sharingConsentVersion: row.sharingConsentVersion,
    sharingRevokedAt: row.sharingRevokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The candidate's profile, or null when they have not saved one yet. */
export async function getOwnProfile(userId: string): Promise<ProfileSummary | null> {
  z.uuid().parse(userId);
  const row = await db.candidateProfile.findUnique({ where: { userId } });
  return row ? toSummary(row) : null;
}

/**
 * Creates the profile on first save (private by default) and updates it
 * afterwards; visibility is never changed as a side effect of saving career
 * fields (FR-PROFILE-002 keeps that an explicit action).
 */
export async function saveOwnProfile(userId: string, input: unknown): Promise<ProfileSummary> {
  z.uuid().parse(userId);

  let parsed: ProfileInput;
  try {
    parsed = profileInputSchema.parse(input);
  } catch (error) {
    throw new ProfileError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid profile input.",
    );
  }

  const data = {
    displayName: parsed.displayName,
    headline: parsed.headline,
    professionalSummary: parsed.professionalSummary,
    targetRole: parsed.targetRole,
    // The zod contract guarantees JSON-serialisable payloads; the boundary
    // cast satisfies Prisma's InputJsonValue typing without loosening
    // runtime validation.
    skillsJson: parsed.skills as unknown as Prisma.InputJsonValue,
    educationJson: parsed.education as unknown as Prisma.InputJsonValue,
    experienceJson: parsed.experience as unknown as Prisma.InputJsonValue,
    portfolioLinksJson: parsed.portfolioLinks as unknown as Prisma.InputJsonValue,
  };

  const row = await db.candidateProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return toSummary(row);
}

/**
 * Explicit publish/hide action (FR-PROFILE-002). The profile must exist:
 * there is nothing to publish before the first save.
 */
export async function setProfileVisibility(
  userId: string,
  visibility: unknown,
): Promise<ProfileSummary> {
  z.uuid().parse(userId);
  const parsed = profileVisibilitySchema.safeParse(visibility);
  if (!parsed.success) {
    throw new ProfileError("invalid_input", "Visibility must be 'private' or 'public'.");
  }

  const existing = await db.candidateProfile.findUnique({ where: { userId } });
  if (!existing) {
    throw new ProfileError("not_found", "Save your profile before changing visibility.");
  }

  const row = await db.candidateProfile.update({
    where: { userId },
    data: { visibility: parsed.data },
  });
  return toSummary(row);
}

/**
 * Recruiter-facing projection (FR-PROFILE-003): null when the profile does
 * not exist or is private. Callers must additionally enforce recruiter role
 * and discovery rules at the route boundary.
 */
export async function getPublicProfile(userId: string): Promise<PublicProfileProjection | null> {
  z.uuid().parse(userId);
  const row = await db.candidateProfile.findUnique({ where: { userId } });
  if (!row || row.visibility !== "public") {
    return null;
  }
  return toPublicProjection(toSummary(row));
}

/** The owner's resume list, newest first. */
export async function listOwnResumes(userId: string): Promise<ResumeSummary[]> {
  z.uuid().parse(userId);
  const rows = await db.candidateResume.findMany({
    where: { profileUserId: userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toResumeSummary);
}

/**
 * Registers a resume upload's metadata with its consent decision
 * (FR-PROFILE-005): sharing is unchecked by default, so consent exists only
 * when the caller explicitly passes it. The storage key is supplied by the
 * storage layer (slice 3b) — this function never sees file bytes.
 */
export async function registerResumeUpload(
  userId: string,
  input: unknown,
): Promise<ResumeSummary> {
  z.uuid().parse(userId);

  const inputSchema = z
    .object({
      originalFileName: z.string().trim().min(1).max(255),
      mimeType: z.string().trim().min(1).max(100),
      fileSizeBytes: z.number().int().positive(),
      storageKey: z.string().trim().min(1).max(500),
      shareWithRecruiters: z.boolean().default(false),
      consentVersion: z.string().optional(),
    })
    .strict();

  let parsed: {
    originalFileName: string;
    mimeType: string;
    fileSizeBytes: number;
    storageKey: string;
    shareWithRecruiters: boolean;
    consentVersion?: string;
  };
  try {
    parsed = inputSchema.parse(input);
  } catch (error) {
    throw new ProfileError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid resume metadata.",
    );
  }

  if (parsed.shareWithRecruiters && !parsed.consentVersion) {
    throw new ProfileError(
      "invalid_input",
      "Sharing consent requires a consent version.",
    );
  }

  // candidate_resume.profile_user_id is an FK to candidate_profile: a resume
  // belongs to a profile. Surface that as a domain rule instead of leaking
  // the database constraint error.
  const profile = await db.candidateProfile.findUnique({ where: { userId } });
  if (!profile) {
    throw new ProfileError(
      "profile_required",
      "Save your profile before uploading a resume.",
    );
  }

  const now = new Date();
  const row = await db.candidateResume.create({
    data: {
      profileUserId: userId,
      originalFileName: parsed.originalFileName,
      mimeType: parsed.mimeType,
      fileSizeBytes: BigInt(parsed.fileSizeBytes),
      storageKey: parsed.storageKey,
      // Unchecked by default: absent consent keeps the resume private
      // (candidate_resume_consent_chk: shared ⇒ timestamp + version present).
      isSharedWithRecruiters: parsed.shareWithRecruiters,
      sharingConsentedAt: parsed.shareWithRecruiters ? now : null,
      sharingConsentVersion: parsed.shareWithRecruiters ? parsed.consentVersion! : null,
    },
  });
  return toResumeSummary(row);
}

async function loadOwnedResume(userId: string, resumeId: string): Promise<CandidateResume> {
  const parsedId = z.uuid().parse(resumeId);
  const row = await db.candidateResume.findUnique({ where: { resumeId: parsedId } });
  if (!row || row.profileUserId !== userId) {
    // Ownership scoping: foreign resumes look exactly like missing ones.
    throw new ProfileError("not_found", "Resume not found.");
  }
  return row;
}

/**
 * Explicit consent change on one owned resume (FR-PROFILE-006). Revocation
 * takes effect immediately (the row flips to not-shared in this transaction);
 * renewed sharing requires a fresh affirmative grant with a consent version.
 */
export async function updateResumeSharing(
  userId: string,
  resumeId: string,
  action: unknown,
): Promise<ResumeSummary> {
  const row = await loadOwnedResume(userId, resumeId);

  const actionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("grant"), consentVersion: z.string().trim() }),
    z.object({ type: z.literal("revoke") }),
  ]);
  const parsedAction = actionSchema.safeParse(action);
  if (!parsedAction.success) {
    throw new ProfileError("invalid_input", "Consent action must be a grant or a revoke.");
  }
  if (parsedAction.data.type === "grant") {
    if (!CONSENT_VERSION_PATTERN.test(parsedAction.data.consentVersion)) {
      throw new ProfileError("invalid_input", "A valid consent version is required.");
    }
  }

  const current: ConsentState = {
    isSharedWithRecruiters: row.isSharedWithRecruiters,
    sharingConsentedAt: row.sharingConsentedAt,
    sharingConsentVersion: row.sharingConsentVersion,
    sharingRevokedAt: row.sharingRevokedAt,
  };
  const write = resolveConsentWrite(
    current,
    parsedAction.data as ConsentAction,
    new Date(),
  );
  if (Object.keys(write).length === 0) {
    return toResumeSummary(row); // idempotent revoke on an already-private resume
  }

  const updated = await db.candidateResume.update({
    where: { resumeId: row.resumeId },
    data: write,
  });
  return toResumeSummary(updated);
}

/**
 * Deletes an owned resume row and returns its storage key so the caller can
 * remove the stored file idempotently (slice 3b wires the storage call).
 */
export async function deleteOwnResume(
  userId: string,
  resumeId: string,
): Promise<{ storageKey: string }> {
  const row = await loadOwnedResume(userId, resumeId);
  await db.candidateResume.delete({ where: { resumeId: row.resumeId } });
  return { storageKey: row.storageKey };
}
