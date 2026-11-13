/**
 * Integration tests: schema constraints derived from the v0.4 data dictionary
 * (TT-3). They run against a dedicated PostgreSQL database provided via
 * TEST_DATABASE_URL and are skipped when it is unset, so the default
 * `pnpm test` stays hermetic (docs/TESTING.md).
 *
 * The suite truncates all application tables before each test: the database
 * must be a disposable one (Prisma dev `aimis-test` server, or the
 * `aimis_test` database on the compose stack â€” never a dev/prod database).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

/** App tables only â€” never _prisma_migrations. */
const APP_TABLES = [
  "media_recording",
  "evaluation_criterion_score",
  "answer_evaluation",
  "interview_evaluation",
  "conversation_message",
  "interview_assessment_unit",
  "interview_session",
  "interview_question_template",
  "interview_category",
  "user_provider_configuration",
  "candidate_resume",
  "candidate_profile",
  "user_account",
] as const;

const d = describe.skipIf(!TEST_DATABASE_URL);

let db: PrismaClient;

beforeAll(() => {
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }) });
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  // Clean slate per test; RESTART IDENTITY so sequences are deterministic.
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${APP_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
});

afterEach(async () => {
  // Leave the database empty (clean up what the suite created).
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${APP_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
});

/** Asserts that the promise fails with a database error naming the constraint. */
function expectConstraintError(promise: Promise<unknown>, constraintName: string) {
  return expect(promise).rejects.toThrow(constraintName);
}

let fixtureSeq = 0;
const nextSuffix = () => `${Date.now().toString(36)}-${++fixtureSeq}`;

async function createAccount(overrides: Partial<Prisma.UserAccountUncheckedCreateInput> = {}) {
  const suffix = nextSuffix();
  return db.userAccount.create({
    data: {
      email: `candidate-${suffix}@example.com`,
      passwordHash: "argon2id-test-hash",
      accountRole: "candidate",
      ...overrides,
    },
  });
}

async function createProfile(overrides: Partial<Prisma.CandidateProfileUncheckedCreateInput> = {}) {
  const account = await createAccount();
  return db.candidateProfile.create({
    data: {
      userId: account.userId,
      displayName: `Test Candidate ${nextSuffix()}`,
      skillsJson: [],
      educationJson: [],
      experienceJson: [],
      portfolioLinksJson: [],
      ...overrides,
    },
  });
}

async function createCategory(overrides: Partial<Prisma.InterviewCategoryUncheckedCreateInput> = {}) {
  const suffix = nextSuffix();
  return db.interviewCategory.create({
    data: {
      categoryCode: `general_${suffix}`,
      categoryName: "General",
      ...overrides,
    },
  });
}

async function createSession(userId: string, categoryId: string, overrides: Partial<Prisma.InterviewSessionUncheckedCreateInput> = {}) {
  return db.interviewSession.create({
    data: {
      userId,
      categoryId,
      jobRole: "Backend Engineer",
      categoryCodeSnapshot: "general",
      categoryNameSnapshot: "General",
      evaluationMode: "balanced",
      runtimeMode: "custom",
      providerRouteSnapshot: {},
      interviewerPromptVersion: "v1",
      ...overrides,
    },
  });
}

async function createEvaluation(sessionId: string, overrides: Partial<Prisma.InterviewEvaluationUncheckedCreateInput> = {}) {
  return db.interviewEvaluation.create({
    data: {
      sessionId,
      scorerProviderNameSnapshot: "OpenAI",
      scorerModelId: "gpt-test-1",
      rubricVersion: "rubric-v1",
      promptVersion: "prompt-v1",
      ...overrides,
    },
  });
}

async function createUnit(sessionId: string, unitNumber: number, overrides: Partial<Prisma.InterviewAssessmentUnitUncheckedCreateInput> = {}) {
  return db.interviewAssessmentUnit.create({
    data: { sessionId, unitNumber, ...overrides },
  });
}

async function createMessage(
  sessionId: string,
  sequenceNumber: number,
  overrides: Partial<Prisma.ConversationMessageUncheckedCreateInput> = {}
) {
  return db.conversationMessage.create({
    data: {
      sessionId,
      sequenceNumber,
      speakerType: "interviewer",
      messageKind: "primary_question",
      contentText: "Tell me about yourself.",
      ...overrides,
    },
  });
}

d("user_account", () => {
  it("accepts each approved access role (FR-AUTH-004)", async () => {
    for (const role of ["candidate", "recruiter", "administrator"]) {
      await expect(createAccount({ accountRole: role })).resolves.toBeTruthy();
    }
  });

  it("rejects a role outside the approved domain", async () => {
    await expectConstraintError(createAccount({ accountRole: "superadmin" }), "user_account_role_domain_chk");
  });

  it("rejects an account status outside the lifecycle domain", async () => {
    await expectConstraintError(createAccount({ accountStatus: "deleted" }), "user_account_status_domain_chk");
  });

  it("rejects a deletion deadline without an explicit deletion request (7-day grace, FR-AUTH-006)", async () => {
    await expectConstraintError(
      createAccount({ deletionDeadlineAt: new Date(Date.now() + 86_400_000) }),
      "user_account_deletion_window_chk"
    );
  });

  it("rejects duplicate sign-in emails", async () => {
    const account = await createAccount();
    await expect(
      db.userAccount.create({
        data: { email: account.email, passwordHash: "argon2id-test-hash", accountRole: "candidate" },
      })
    ).rejects.toThrow();
  });

  it("defaults status to active and exposes a pending_deletion state", async () => {
    const account = await createAccount();
    expect(account.accountStatus).toBe("active");
    const pending = await createAccount({
      deletionRequestedAt: new Date(),
      deletionDeadlineAt: new Date(Date.now() + 7 * 86_400_000),
      accountStatus: "pending_deletion",
    });
    expect(pending.accountStatus).toBe("pending_deletion");
  });
});

d("candidate_profile", () => {
  it("defaults visibility to private (privacy by default)", async () => {
    const profile = await createProfile();
    expect(profile.visibility).toBe("private");
  });

  it("rejects a visibility outside the domain", async () => {
    await expectConstraintError(createProfile({ visibility: "friends" }), "candidate_profile_visibility_domain_chk");
  });

  it("cascades deletion with the account (profile is account-owned)", async () => {
    const profile = await createProfile();
    await db.userAccount.delete({ where: { userId: profile.userId } });
    await expect(db.candidateProfile.findUnique({ where: { userId: profile.userId } })).resolves.toBeNull();
  });
});

d("candidate_resume consent state machine", () => {
  async function baseResume() {
    const profile = await createProfile();
    return db.candidateResume.create({
      data: {
        profileUserId: profile.userId,
        originalFileName: "resume.pdf",
        storageKey: `resumes/${profile.userId}/resume.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: 1024n,
      },
    });
  }

  it("defaults to not shared with recruiters (unchecked by default, FR-PROFILE-005)", async () => {
    const resume = await baseResume();
    expect(resume.isSharedWithRecruiters).toBe(false);
    expect(resume.sharingConsentedAt).toBeNull();
    expect(resume.sharingConsentVersion).toBeNull();
    expect(resume.sharingRevokedAt).toBeNull();
  });

  it("rejects sharing without an explicit consent timestamp and notice version", async () => {
    const profile = await createProfile();
    await expectConstraintError(
      db.candidateResume.create({
        data: {
          profileUserId: profile.userId,
          originalFileName: "resume.pdf",
          storageKey: "k",
          mimeType: "application/pdf",
          fileSizeBytes: 1n,
          isSharedWithRecruiters: true,
        },
      }),
      "candidate_resume_consent_chk"
    );
  });

  it("accepts sharing with full consent metadata", async () => {
    const profile = await createProfile();
    const resume = await db.candidateResume.create({
      data: {
        profileUserId: profile.userId,
        originalFileName: "resume.pdf",
        storageKey: "k",
        mimeType: "application/pdf",
        fileSizeBytes: 1n,
        isSharedWithRecruiters: true,
        sharingConsentedAt: new Date(),
        sharingConsentVersion: "v1",
      },
    });
    expect(resume.isSharedWithRecruiters).toBe(true);
  });

  it("rejects a revoked resume that claims to be shared (immediate revocation, FR-PROFILE-006)", async () => {
    const profile = await createProfile();
    await expectConstraintError(
      db.candidateResume.create({
        data: {
          profileUserId: profile.userId,
          originalFileName: "resume.pdf",
          storageKey: "k",
          mimeType: "application/pdf",
          fileSizeBytes: 1n,
          isSharedWithRecruiters: true,
          sharingConsentedAt: new Date(),
          sharingConsentVersion: "v1",
          sharingRevokedAt: new Date(),
        },
      }),
      "candidate_resume_revocation_chk"
    );
  });

  it("cascades deletion with the profile and account", async () => {
    const profile = await createProfile();
    const resume = await db.candidateResume.create({
      data: {
        profileUserId: profile.userId,
        originalFileName: "resume.pdf",
        storageKey: "k",
        mimeType: "application/pdf",
        fileSizeBytes: 1n,
      },
    });
    await db.userAccount.delete({ where: { userId: profile.userId } });
    await expect(db.candidateResume.findUnique({ where: { resumeId: resume.resumeId } })).resolves.toBeNull();
  });
});

d("user_provider_configuration", () => {
  it("rejects a provider type outside preset/custom", async () => {
    const account = await createAccount();
    await expectConstraintError(
      db.userProviderConfiguration.create({
        data: {
          userId: account.userId,
          providerType: "hybrid",
          providerName: "OpenAI",
          capabilitiesJson: {},
        },
      }),
      "user_provider_configuration_type_domain_chk"
    );
  });

  it("rejects a custom connection without a Base URL", async () => {
    const account = await createAccount();
    await expectConstraintError(
      db.userProviderConfiguration.create({
        data: {
          userId: account.userId,
          providerType: "custom",
          providerName: "My Gateway",
          capabilitiesJson: { llm: { model_id: "gpt-test-1" } },
        },
      }),
      "user_provider_configuration_custom_base_url_chk"
    );
  });

  it("rejects an encrypted key without the master-key version (ADR-0005)", async () => {
    const account = await createAccount();
    await expectConstraintError(
      db.userProviderConfiguration.create({
        data: {
          userId: account.userId,
          providerType: "preset",
          providerName: "OpenAI",
          encryptedApiKey: Buffer.from([1, 2, 3]),
          capabilitiesJson: {},
        },
      }),
      "user_provider_configuration_key_version_chk"
    );
  });

  it("accepts a keyless preset connection", async () => {
    const account = await createAccount();
    const config = await db.userProviderConfiguration.create({
      data: {
        userId: account.userId,
        providerType: "preset",
        providerName: "Local Keyless",
        capabilitiesJson: {},
      },
    });
    expect(config.encryptedApiKey).toBeNull();
    expect(config.credentialStatus).toBe("unvalidated");
    expect(config.isEnabled).toBe(true);
    expect(config.configurationVersion).toBe(1);
  });

  it("cascades deletion with the account (BYOK credentials die with the owner)", async () => {
    const account = await createAccount();
    const config = await db.userProviderConfiguration.create({
      data: { userId: account.userId, providerType: "preset", providerName: "OpenAI", capabilitiesJson: {} },
    });
    await db.userAccount.delete({ where: { userId: account.userId } });
    await expect(
      db.userProviderConfiguration.findUnique({ where: { userProviderConfigurationId: config.userProviderConfigurationId } })
    ).resolves.toBeNull();
  });
});

d("interview_question_template", () => {
  it("rejects duplicate (template_code, version_number)", async () => {
    const category = await createCategory();
    const data = {
      categoryId: category.categoryId,
      templateCode: "behavioural_core",
      templateName: "Behavioural Core",
      templateContent: "Generate a question about {topic}.",
      versionNumber: 1,
      status: "active",
    } satisfies Prisma.InterviewQuestionTemplateUncheckedCreateInput;
    await db.interviewQuestionTemplate.create({ data });
    await expect(db.interviewQuestionTemplate.create({ data })).rejects.toThrow();
  });

  it("allows only one active version per template_code (partial unique index)", async () => {
    const category = await createCategory();
    const base = {
      categoryId: category.categoryId,
      templateCode: "technical_core",
      templateName: "Technical Core",
      templateContent: "content",
    };
    await db.interviewQuestionTemplate.create({ data: { ...base, versionNumber: 1, status: "active" } });
    await expect(
      db.interviewQuestionTemplate.create({ data: { ...base, versionNumber: 2, status: "active" } })
    ).rejects.toThrow("interview_question_template_active_code_uniq_idx");
  });

  it("allows multiple retired versions of the same template_code", async () => {
    const category = await createCategory();
    const base = {
      categoryId: category.categoryId,
      templateCode: "hr_screening",
      templateName: "HR Screening",
      templateContent: "content",
    };
    await db.interviewQuestionTemplate.create({ data: { ...base, versionNumber: 1, status: "retired" } });
    await db.interviewQuestionTemplate.create({ data: { ...base, versionNumber: 2, status: "retired" } });
    const rows = await db.interviewQuestionTemplate.count({ where: { templateCode: "hr_screening" } });
    expect(rows).toBe(2);
  });

  it("restricts deletion while sessions or categories reference it", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const template = await db.interviewQuestionTemplate.create({
      data: {
        categoryId: category.categoryId,
        templateCode: "locked_template",
        templateName: "Locked Template",
        templateContent: "content",
        status: "active",
      },
    });
    await createSession(account.userId, category.categoryId, { questionTemplateId: template.templateId });
    await expect(db.interviewQuestionTemplate.delete({ where: { templateId: template.templateId } })).rejects.toThrow();
    await expect(db.interviewCategory.delete({ where: { categoryId: category.categoryId } })).rejects.toThrow();
  });

  it("sets created_by to null when the administrator account is deleted", async () => {
    const admin = await createAccount({ accountRole: "administrator" });
    const category = await createCategory({ createdByUserId: admin.userId });
    const template = await db.interviewQuestionTemplate.create({
      data: {
        categoryId: category.categoryId,
        templateCode: "owned_template",
        templateName: "Owned Template",
        templateContent: "content",
        status: "draft",
        createdByUserId: admin.userId,
      },
    });
    await db.userAccount.delete({ where: { userId: admin.userId } });
    const reloaded = await db.interviewQuestionTemplate.findUnique({ where: { templateId: template.templateId } });
    expect(reloaded?.createdByUserId).toBeNull();
    expect((await db.interviewCategory.findUnique({ where: { categoryId: category.categoryId } }))?.createdByUserId).toBeNull();
  });
});

d("interview_session", () => {
  it("rejects an evaluation mode outside Supportive/Balanced/Rigorous (FR-SETUP-004)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    await expectConstraintError(
      createSession(account.userId, category.categoryId, { evaluationMode: "lenient" }),
      "interview_session_evaluation_mode_domain_chk"
    );
  });

  it("rejects a runtime outside the mutually exclusive pair (FR-SETUP-005)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    await expectConstraintError(
      createSession(account.userId, category.categoryId, { runtimeMode: "hybrid_realtime" }),
      "interview_session_runtime_mode_domain_chk"
    );
  });

  it("rejects a status outside the lifecycle domain", async () => {
    const account = await createAccount();
    const category = await createCategory();
    await expectConstraintError(
      createSession(account.userId, category.categoryId, { status: "archived" }),
      "interview_session_status_domain_chk"
    );
  });

  it("rejects completion before start", async () => {
    const account = await createAccount();
    const category = await createCategory();
    await expectConstraintError(
      createSession(account.userId, category.categoryId, { completedAt: new Date() }),
      "interview_session_lifecycle_chk"
    );
  });

  it("accepts a valid lifecycle (created â†’ active â†’ completed)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const started = new Date(Date.now() - 1000);
    const session = await createSession(account.userId, category.categoryId, {
      status: "completed",
      startedAt: started,
      completedAt: new Date(),
    });
    expect(session.status).toBe("completed");
  });

  it("cascades transcript, units, evaluation and recordings on meeting deletion (FR-HISTORY-006)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    const unit = await createUnit(session.sessionId, 1);
    const message = await createMessage(session.sessionId, 1, { assessmentUnitId: unit.assessmentUnitId });
    const evaluation = await createEvaluation(session.sessionId);
    const answer = await db.answerEvaluation.create({
      data: {
        evaluationId: evaluation.evaluationId,
        assessmentUnitId: unit.assessmentUnitId,
        overallScore: 4,
        feedbackText: "Good structure.",
        recommendedAnswer: "Use the STAR method.",
        strengthsJson: [],
        improvementAreasJson: [],
      },
    });
    const criterion = await db.evaluationCriterionScore.create({
      data: {
        answerEvaluationId: answer.answerEvaluationId,
        criterionCode: "relevance",
        criterionLabelSnapshot: "Relevance",
        scoreValue: 4,
        maxScore: 5,
        weightSnapshot: 0.3,
      },
    });
    const recording = await db.mediaRecording.create({
      data: {
        sessionId: session.sessionId,
        mediaType: "audio",
        storageKey: "recordings/x",
        mimeType: "audio/webm",
        consentedAt: new Date(),
        consentVersion: "v1",
        recordingStartedAt: new Date(),
      },
    });

    await db.interviewSession.delete({ where: { sessionId: session.sessionId } });

    await expect(db.conversationMessage.findUnique({ where: { messageId: message.messageId } })).resolves.toBeNull();
    await expect(db.interviewAssessmentUnit.findUnique({ where: { assessmentUnitId: unit.assessmentUnitId } })).resolves.toBeNull();
    await expect(db.interviewEvaluation.findUnique({ where: { evaluationId: evaluation.evaluationId } })).resolves.toBeNull();
    await expect(db.answerEvaluation.findUnique({ where: { answerEvaluationId: answer.answerEvaluationId } })).resolves.toBeNull();
    await expect(
      db.evaluationCriterionScore.findUnique({
        where: { answerEvaluationId_criterionCode: { answerEvaluationId: answer.answerEvaluationId, criterionCode: criterion.criterionCode } },
      })
    ).resolves.toBeNull();
    await expect(db.mediaRecording.findUnique({ where: { recordingId: recording.recordingId } })).resolves.toBeNull();
  });

  it("cascades the full interview history when the account is deleted (FR-AUTH-009)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    const message = await createMessage(session.sessionId, 1);
    await createEvaluation(session.sessionId);

    await db.userAccount.delete({ where: { userId: account.userId } });

    await expect(db.interviewSession.findUnique({ where: { sessionId: session.sessionId } })).resolves.toBeNull();
    await expect(db.conversationMessage.findUnique({ where: { messageId: message.messageId } })).resolves.toBeNull();
    await expect(db.interviewEvaluation.count({ where: { sessionId: session.sessionId } })).resolves.toBe(0);
  });
});

d("conversation_message", () => {
  it("rejects a duplicate (session_id, sequence_number) â€” idempotent transcript writes (NFR-REL-002)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await createMessage(session.sessionId, 1);
    await expect(createMessage(session.sessionId, 1)).rejects.toThrow();
  });

  it("rejects sequence numbers below 1", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await expectConstraintError(createMessage(session.sessionId, 0), "conversation_message_sequence_positive_chk");
  });

  it("rejects a replayed idempotency key within the same session", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await createMessage(session.sessionId, 1, { idempotencyKey: "turn-abc" });
    await expect(createMessage(session.sessionId, 2, { idempotencyKey: "turn-abc" })).rejects.toThrow(
      "conversation_message_session_idempotency_key_uniq_idx"
    );
  });

  it("allows the same idempotency key in a different session", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const s1 = await createSession(account.userId, category.categoryId);
    const s2 = await createSession(account.userId, category.categoryId);
    await createMessage(s1.sessionId, 1, { idempotencyKey: "turn-shared" });
    const m2 = await createMessage(s2.sessionId, 1, { idempotencyKey: "turn-shared" });
    expect(m2.idempotencyKey).toBe("turn-shared");
  });

  it("rejects a candidate input mode on an interviewer message", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await expectConstraintError(
      createMessage(session.sessionId, 1, { candidateInputMode: "text" }),
      "conversation_message_input_mode_speaker_chk"
    );
  });

  it("rejects out-of-domain speakers, kinds and input modes", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await expectConstraintError(createMessage(session.sessionId, 1, { speakerType: "system" }), "conversation_message_speaker_domain_chk");
    await expectConstraintError(createMessage(session.sessionId, 1, { messageKind: "rambling" }), "conversation_message_kind_domain_chk");
    await expectConstraintError(
      createMessage(session.sessionId, 1, {
        speakerType: "candidate",
        candidateInputMode: "telepathy",
      }),
      "conversation_message_input_mode_domain_chk"
    );
  });

  it("sets the unit reference to null when the assessment unit is deleted (transcript survives)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    const unit = await createUnit(session.sessionId, 1);
    const message = await createMessage(session.sessionId, 1, { assessmentUnitId: unit.assessmentUnitId });
    await db.interviewAssessmentUnit.delete({ where: { assessmentUnitId: unit.assessmentUnitId } });
    const reloaded = await db.conversationMessage.findUnique({ where: { messageId: message.messageId } });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.assessmentUnitId).toBeNull();
  });
});

d("interview_assessment_unit", () => {
  it("rejects duplicate (session, unit_number)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await createUnit(session.sessionId, 1);
    await expect(createUnit(session.sessionId, 1)).rejects.toThrow();
  });

  it("rejects unit_number below 1", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await expectConstraintError(createUnit(session.sessionId, 0), "interview_assessment_unit_number_positive_chk");
  });

  it("keeps open/closed lifecycle consistent", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await expectConstraintError(
      createUnit(session.sessionId, 1, { closedAt: new Date() }),
      "interview_assessment_unit_lifecycle_chk"
    );
    const closed = await createUnit(session.sessionId, 2, { status: "closed", closedAt: new Date() });
    expect(closed.status).toBe("closed");
  });
});

d("interview_evaluation", () => {
  it("prevents a duplicate consolidated evaluation per session (FR-ASYNC-007)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await createEvaluation(session.sessionId);
    await expect(createEvaluation(session.sessionId)).rejects.toThrow();
  });

  it("keeps a queued job without a completed timestamp", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await expectConstraintError(
      createEvaluation(session.sessionId, { completedAt: new Date() }),
      "interview_evaluation_completed_chk"
    );
  });

  it("rejects a job status outside queued/processing/completed/failed (FR-ASYNC-005)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    await expectConstraintError(
      createEvaluation(session.sessionId, { evaluationStatus: "cancelled" }),
      "interview_evaluation_status_domain_chk"
    );
  });

  it("confines the weighted overall score to the approved 1â€“5 scale (FR-EVAL-008/013)", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    const evaluation = await createEvaluation(session.sessionId);
    await expectConstraintError(
      db.interviewEvaluation.update({ where: { evaluationId: evaluation.evaluationId }, data: { overallScore: 0.5 } }),
      "interview_evaluation_overall_score_range_chk"
    );
    await expectConstraintError(
      db.interviewEvaluation.update({ where: { evaluationId: evaluation.evaluationId }, data: { overallScore: 5.5 } }),
      "interview_evaluation_overall_score_range_chk"
    );
    const updated = await db.interviewEvaluation.update({
      where: { evaluationId: evaluation.evaluationId },
      data: { overallScore: 4.25 },
    });
    expect(Number(updated.overallScore)).toBeCloseTo(4.25);
  });

  it("rejects negative attempt counts", async () => {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    const evaluation = await createEvaluation(session.sessionId);
    await expectConstraintError(
      db.interviewEvaluation.update({ where: { evaluationId: evaluation.evaluationId }, data: { attemptCount: -1 } }),
      "interview_evaluation_attempts_chk"
    );
  });

  it("detaches the scorer configuration when the provider connection is deleted (SET NULL)", async () => {
    const account = await createAccount();
    const config = await db.userProviderConfiguration.create({
      data: { userId: account.userId, providerType: "preset", providerName: "OpenAI", capabilitiesJson: {} },
    });
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    const evaluation = await createEvaluation(session.sessionId, {
      scorerConfigurationId: config.userProviderConfigurationId,
    });
    await db.userProviderConfiguration.delete({ where: { userProviderConfigurationId: config.userProviderConfigurationId } });
    const reloaded = await db.interviewEvaluation.findUnique({ where: { evaluationId: evaluation.evaluationId } });
    expect(reloaded?.scorerConfigurationId).toBeNull();
  });
});

d("answer_evaluation", () => {
  async function base() {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    const unit = await createUnit(session.sessionId, 1);
    const evaluation = await createEvaluation(session.sessionId);
    return { account, category, session, unit, evaluation };
  }

  it("allows exactly one evaluation result per assessment unit", async () => {
    const { unit, evaluation } = await base();
    const data = {
      evaluationId: evaluation.evaluationId,
      assessmentUnitId: unit.assessmentUnitId,
      overallScore: 3.5,
      feedbackText: "Solid but brief.",
      recommendedAnswer: "Expand with metrics.",
      strengthsJson: [],
      improvementAreasJson: [],
    } satisfies Prisma.AnswerEvaluationUncheckedCreateInput;
    await db.answerEvaluation.create({ data });
    await expect(db.answerEvaluation.create({ data: { ...data, evaluationId: evaluation.evaluationId } })).rejects.toThrow();
  });

  it("confines the unit score to 1â€“5", async () => {
    const { unit, evaluation } = await base();
    const baseData = {
      evaluationId: evaluation.evaluationId,
      assessmentUnitId: unit.assessmentUnitId,
      feedbackText: "f",
      recommendedAnswer: "r",
      strengthsJson: [],
      improvementAreasJson: [],
    };
    await expectConstraintError(
      db.answerEvaluation.create({ data: { ...baseData, overallScore: 0 } }),
      "answer_evaluation_overall_score_range_chk"
    );
    await expectConstraintError(
      db.answerEvaluation.create({ data: { ...baseData, overallScore: 6 } }),
      "answer_evaluation_overall_score_range_chk"
    );
  });

  it("cascades with the assessment unit", async () => {
    const { unit, evaluation } = await base();
    const answer = await db.answerEvaluation.create({
      data: {
        evaluationId: evaluation.evaluationId,
        assessmentUnitId: unit.assessmentUnitId,
        overallScore: 4,
        feedbackText: "f",
        recommendedAnswer: "r",
        strengthsJson: [],
        improvementAreasJson: [],
      },
    });
    await db.interviewAssessmentUnit.delete({ where: { assessmentUnitId: unit.assessmentUnitId } });
    await expect(db.answerEvaluation.findUnique({ where: { answerEvaluationId: answer.answerEvaluationId } })).resolves.toBeNull();
  });
});

d("evaluation_criterion_score", () => {
  async function baseScore() {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    const unit = await createUnit(session.sessionId, 1);
    const evaluation = await createEvaluation(session.sessionId);
    const answer = await db.answerEvaluation.create({
      data: {
        evaluationId: evaluation.evaluationId,
        assessmentUnitId: unit.assessmentUnitId,
        overallScore: 4,
        feedbackText: "f",
        recommendedAnswer: "r",
        strengthsJson: [],
        improvementAreasJson: [],
      },
    });
    return { answer };
  }

  const baseData = {
    criterionCode: "accuracy",
    criterionLabelSnapshot: "Accuracy",
    scoreValue: 4,
    maxScore: 5,
    weightSnapshot: 0.25,
  };

  it("rejects scores outside the anchored 1â€“5 integers", async () => {
    const { answer } = await baseScore();
    await expectConstraintError(
      db.evaluationCriterionScore.create({ data: { ...baseData, answerEvaluationId: answer.answerEvaluationId, scoreValue: 0 } }),
      "evaluation_criterion_score_value_range_chk"
    );
    await expectConstraintError(
      db.evaluationCriterionScore.create({ data: { ...baseData, answerEvaluationId: answer.answerEvaluationId, scoreValue: 6 } }),
      "evaluation_criterion_score_value_range_chk"
    );
  });

  it("rejects weights above 1 or non-positive", async () => {
    const { answer } = await baseScore();
    await expectConstraintError(
      db.evaluationCriterionScore.create({ data: { ...baseData, answerEvaluationId: answer.answerEvaluationId, weightSnapshot: 1.5 } }),
      "evaluation_criterion_score_weight_chk"
    );
    await expectConstraintError(
      db.evaluationCriterionScore.create({ data: { ...baseData, answerEvaluationId: answer.answerEvaluationId, weightSnapshot: 0 } }),
      "evaluation_criterion_score_weight_chk"
    );
  });

  it("never scores above the rubric maximum and bounds the maximum itself", async () => {
    const { answer } = await baseScore();
    await expectConstraintError(
      db.evaluationCriterionScore.create({
        data: { ...baseData, answerEvaluationId: answer.answerEvaluationId, scoreValue: 5, maxScore: 4 },
      }),
      "evaluation_criterion_score_score_le_max_chk"
    );
    await expectConstraintError(
      db.evaluationCriterionScore.create({ data: { ...baseData, answerEvaluationId: answer.answerEvaluationId, maxScore: 6 } }),
      "evaluation_criterion_score_max_range_chk"
    );
  });

  it("rejects a duplicate criterion for the same answer evaluation (composite PK)", async () => {
    const { answer } = await baseScore();
    await db.evaluationCriterionScore.create({ data: { ...baseData, answerEvaluationId: answer.answerEvaluationId } });
    await expect(
      db.evaluationCriterionScore.create({ data: { ...baseData, answerEvaluationId: answer.answerEvaluationId } })
    ).rejects.toThrow();
  });

  it("cascades with the answer evaluation", async () => {
    const { answer } = await baseScore();
    const score = await db.evaluationCriterionScore.create({ data: { ...baseData, answerEvaluationId: answer.answerEvaluationId } });
    await db.answerEvaluation.delete({ where: { answerEvaluationId: answer.answerEvaluationId } });
    await expect(
      db.evaluationCriterionScore.findUnique({
        where: { answerEvaluationId_criterionCode: { answerEvaluationId: answer.answerEvaluationId, criterionCode: score.criterionCode } },
      })
    ).resolves.toBeNull();
  });
});

d("media_recording (deferred scope, schema behaviour)", () => {
  async function base() {
    const account = await createAccount();
    const category = await createCategory();
    const session = await createSession(account.userId, category.categoryId);
    return session;
  }

  function recordingData(sessionId: string) {
    return {
      sessionId,
      mediaType: "audio",
      storageKey: "recordings/a",
      mimeType: "audio/webm",
      fileSizeBytes: 10n,
      consentedAt: new Date(),
      consentVersion: "v1",
      recordingStartedAt: new Date(),
    };
  }

  it("rejects a deletion status outside the lifecycle domain", async () => {
    const session = await base();
    await expectConstraintError(
      db.mediaRecording.create({ data: { ...recordingData(session.sessionId), deletionStatus: "deleted" } }),
      "media_recording_deletion_status_domain_chk"
    );
  });

  it("cascades deletion with the meeting", async () => {
    const session = await base();
    const recording = await db.mediaRecording.create({ data: recordingData(session.sessionId) });
    await db.interviewSession.delete({ where: { sessionId: session.sessionId } });
    await expect(db.mediaRecording.findUnique({ where: { recordingId: recording.recordingId } })).resolves.toBeNull();
  });
});
