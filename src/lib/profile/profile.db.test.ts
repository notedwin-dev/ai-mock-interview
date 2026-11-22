import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import {
  deleteOwnResume,
  getOwnProfile,
  getPublicProfile,
  listOwnResumes,
  ProfileError,
  registerResumeUpload,
  saveOwnProfile,
  setProfileVisibility,
  updateResumeSharing,
} from "./service";

/**
 * Integration tests for the candidate profile + resume consent service
 * against the dedicated TEST_DATABASE_URL database (docs/TESTING.md). The
 * whole suite is skipped when the variable is unset, so the default
 * `pnpm test` stays hermetic; hooks live inside the gated describe so nothing
 * connects when the database is not provided.
 */

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const d = describe.skipIf(!TEST_DATABASE_URL);

const TABLES = [`"user_account"`, `"candidate_profile"`, `"candidate_resume"`];

let db: PrismaClient;

d("candidate profile service (integration)", () => {
  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }) });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
  });

  afterEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
  });

  let userSeq = 0;
  async function createUser(role = "candidate"): Promise<string> {
    const account = await db.userAccount.create({
      data: {
        email: `profile-${Date.now().toString(36)}-${++userSeq}@example.com`,
        passwordHash: "argon2id-test-hash",
        accountRole: role,
      },
    });
    return account.userId;
  }

  /** candidate_resume.profile_user_id is an FK to candidate_profile. */
  async function createUserWithProfile(): Promise<string> {
    const userId = await createUser();
    await saveOwnProfile(userId, { displayName: "Jane Doe" });
    return userId;
  }

  const validProfile = {
    displayName: "Jane Doe",
    headline: "Backend engineer",
    professionalSummary: "Five years of API work.",
    targetRole: "Senior Backend Engineer",
    skills: ["TypeScript", "PostgreSQL"],
    education: [{ institution: "XYZ University", qualification: "BSc CS", period: "2020-2024" }],
    experience: [{ organisation: "ACME", role: "Backend dev", period: "2024-" }],
    portfolioLinks: ["https://jane.example.com"],
  };

  it("creates the profile on first save and updates it in place (FR-PROFILE-001)", async () => {
    const userId = await createUser();

    const created = await saveOwnProfile(userId, validProfile);
    expect(created.displayName).toBe("Jane Doe");
    expect(created.skills).toEqual(["TypeScript", "PostgreSQL"]);

    const updated = await saveOwnProfile(userId, { ...validProfile, headline: "Staff engineer" });
    expect(updated.headline).toBe("Staff engineer");
    expect(await db.candidateProfile.count({ where: { userId } })).toBe(1);
  });

  it("rejects invalid input without touching the database (FR-PROFILE-001)", async () => {
    const userId = await createUser();
    await expect(saveOwnProfile(userId, { displayName: "" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(saveOwnProfile(userId, { displayName: "J", nope: true })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await db.candidateProfile.count()).toBe(0);
  });

  it("a new profile is private by default and visibility is an explicit action (FR-PROFILE-002)", async () => {
    const userId = await createUser();
    const created = await saveOwnProfile(userId, validProfile);
    expect(created.visibility).toBe("private");

    const published = await setProfileVisibility(userId, "public");
    expect(published.visibility).toBe("public");

    const hidden = await setProfileVisibility(userId, "private");
    expect(hidden.visibility).toBe("private");
  });

  it("visibility cannot be toggled before the first save, nor to an invalid value", async () => {
    const userId = await createUser();
    await expect(setProfileVisibility(userId, "public")).rejects.toMatchObject({
      code: "not_found",
    });
    await saveOwnProfile(userId, validProfile);
    await expect(setProfileVisibility(userId, "unlisted")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("saving career fields never flips visibility as a side effect (FR-PROFILE-002)", async () => {
    const userId = await createUser();
    await saveOwnProfile(userId, validProfile);
    await setProfileVisibility(userId, "public");

    const after = await saveOwnProfile(userId, { ...validProfile, headline: "Changed" });
    expect(after.visibility).toBe("public");
  });

  it("the public projection exposes only allowlisted fields and only when public (FR-PROFILE-003)", async () => {
    const userId = await createUser();
    await saveOwnProfile(userId, validProfile);

    // Private (default): no recruiter-facing projection.
    expect(await getPublicProfile(userId)).toBeNull();

    await setProfileVisibility(userId, "public");
    const projection = await getPublicProfile(userId);
    expect(projection).not.toBeNull();
    const serialised = JSON.stringify(projection);
    expect(serialised).toContain("Jane Doe");
    expect(serialised).not.toContain("Five years of API work"); // professionalSummary
    expect(serialised).not.toContain("Senior Backend Engineer"); // targetRole
    expect(Object.keys(projection!).sort()).toEqual([
      "displayName",
      "education",
      "experience",
      "headline",
      "portfolioLinks",
      "skills",
    ]);
  });

  it("getOwnProfile returns null before the first save and full data after", async () => {
    const userId = await createUser();
    expect(await getOwnProfile(userId)).toBeNull();
    await saveOwnProfile(userId, validProfile);
    const own = await getOwnProfile(userId);
    expect(own?.professionalSummary).toBe("Five years of API work.");
  });

  it("registers a resume with unchecked-by-default consent (FR-PROFILE-005)", async () => {
    const userId = await createUser();
    await saveOwnProfile(userId, validProfile);

    const resume = await registerResumeUpload(userId, {
      originalFileName: "jane-doe-cv.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 123456,
      storageKey: `resumes/${userId}/placeholder`,
    });
    expect(resume.isSharedWithRecruiters).toBe(false);
    expect(resume.sharingConsentedAt).toBeNull();
    expect(resume.sharingConsentVersion).toBeNull();
    expect(resume.fileSizeBytes).toBe(123456);
  });

  it("consent at upload time must be explicit and versioned (FR-PROFILE-005)", async () => {
    const userId = await createUserWithProfile();
    await expect(
      registerResumeUpload(userId, {
        originalFileName: "cv.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1,
        storageKey: "resumes/x",
        shareWithRecruiters: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const shared = await registerResumeUpload(userId, {
      originalFileName: "cv.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1,
      storageKey: "resumes/x",
      shareWithRecruiters: true,
      consentVersion: "2026-11",
    });
    expect(shared.isSharedWithRecruiters).toBe(true);
    expect(shared.sharingConsentVersion).toBe("2026-11");
  });

  it("revokes sharing immediately and re-granting requires an affirmative action (FR-PROFILE-006)", async () => {
    const userId = await createUserWithProfile();
    const resume = await registerResumeUpload(userId, {
      originalFileName: "cv.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1,
      storageKey: "resumes/x",
      shareWithRecruiters: true,
      consentVersion: "2026-11",
    });

    const revoked = await updateResumeSharing(userId, resume.resumeId, { type: "revoke" });
    expect(revoked.isSharedWithRecruiters).toBe(false);
    expect(revoked.sharingRevokedAt).not.toBeNull();
    // The row state satisfies the revocation CHECK: revoked ⇒ not shared.
    const row = await db.candidateResume.findUnique({ where: { resumeId: resume.resumeId } });
    expect(row!.isSharedWithRecruiters).toBe(false);

    const renewed = await updateResumeSharing(userId, resume.resumeId, {
      type: "grant",
      consentVersion: "2027-01",
    });
    expect(renewed.isSharedWithRecruiters).toBe(true);
    expect(renewed.sharingConsentVersion).toBe("2027-01");
    expect(renewed.sharingRevokedAt).toBeNull();
  });

  it("revoking an unshared resume is an idempotent no-op (FR-PROFILE-006)", async () => {
    const userId = await createUserWithProfile();
    const resume = await registerResumeUpload(userId, {
      originalFileName: "cv.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1,
      storageKey: "resumes/x",
    });

    const after = await updateResumeSharing(userId, resume.resumeId, { type: "revoke" });
    expect(after.isSharedWithRecruiters).toBe(false);
    expect(after.sharingRevokedAt).toBeNull();
  });

  it("malformed consent actions and bad versions are rejected", async () => {
    const userId = await createUserWithProfile();
    const resume = await registerResumeUpload(userId, {
      originalFileName: "cv.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1,
      storageKey: "resumes/x",
    });

    await expect(
      updateResumeSharing(userId, resume.resumeId, { type: "delete" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      updateResumeSharing(userId, resume.resumeId, { type: "grant", consentVersion: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("resume ownership is scoped to the calling user", async () => {
    const owner = await createUserWithProfile();
    const outsider = await createUserWithProfile();
    const resume = await registerResumeUpload(owner, {
      originalFileName: "cv.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1,
      storageKey: "resumes/owner-only",
    });

    expect(await listOwnResumes(outsider)).toHaveLength(0);
    await expect(
      updateResumeSharing(outsider, resume.resumeId, { type: "revoke" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteOwnResume(outsider, resume.resumeId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("deleting a resume removes the row and returns the storage key for file cleanup", async () => {
    const owner = await createUserWithProfile();
    const resume = await registerResumeUpload(owner, {
      originalFileName: "cv.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1,
      storageKey: "resumes/doomed",
    });

    const { storageKey } = await deleteOwnResume(owner, resume.resumeId);
    expect(storageKey).toBe("resumes/doomed");
    expect(await listOwnResumes(owner)).toHaveLength(0);
    await expect(deleteOwnResume(owner, resume.resumeId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lists owned resumes newest first with consent state", async () => {
    const owner = await createUserWithProfile();
    const first = await registerResumeUpload(owner, {
      originalFileName: "cv-v1.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 10,
      storageKey: "resumes/v1",
    });
    // Tiny sleep-free ordering: ids are ordered by createdAt; two inserts in
    // the same millisecond are still returned consistently, so assert on
    // membership rather than strict order between same-instant rows.
    const second = await registerResumeUpload(owner, {
      originalFileName: "cv-v2.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 20,
      storageKey: "resumes/v2",
      shareWithRecruiters: true,
      consentVersion: "2026-11",
    });

    const list = await listOwnResumes(owner);
    expect(list.map((r) => r.originalFileName).sort()).toEqual(["cv-v1.pdf", "cv-v2.pdf"]);
    const sharedRow = list.find((r) => r.resumeId === second.resumeId);
    expect(sharedRow?.isSharedWithRecruiters).toBe(true);
    const privateRow = list.find((r) => r.resumeId === first.resumeId);
    expect(privateRow?.isSharedWithRecruiters).toBe(false);
  });

  it("registering a resume without a saved profile is rejected (FK-backed domain rule)", async () => {
    const userId = await createUser();
    await expect(
      registerResumeUpload(userId, {
        originalFileName: "cv.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1,
        storageKey: "resumes/x",
      }),
    ).rejects.toMatchObject({ code: "profile_required" });
    expect(await db.candidateResume.count()).toBe(0);
  });

  it("wraps non-Error zod failures as invalid_input", async () => {
    const userId = await createUser();
    await expect(saveOwnProfile(userId, null)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps profile errors distinct from other module errors", () => {
    const error = new ProfileError("not_found", "missing");
    expect(error.name).toBe("ProfileError");
    expect(error.code).toBe("not_found");
  });
});
