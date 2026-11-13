-- CreateTable
CREATE TABLE "user_account" (
    "user_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "account_role" VARCHAR(20) NOT NULL,
    "account_status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "email_verified_at" TIMESTAMPTZ(6),
    "deletion_requested_at" TIMESTAMPTZ(6),
    "deletion_deadline_at" TIMESTAMPTZ(6),
    "deactivated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "candidate_profile" (
    "user_id" UUID NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "headline" VARCHAR(160),
    "professional_summary" TEXT,
    "target_role" VARCHAR(150),
    "skills_json" JSONB NOT NULL,
    "education_json" JSONB NOT NULL,
    "experience_json" JSONB NOT NULL,
    "portfolio_links_json" JSONB NOT NULL,
    "visibility" VARCHAR(20) NOT NULL DEFAULT 'private',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "candidate_profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "candidate_resume" (
    "resume_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_user_id" UUID NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "is_shared_with_recruiters" BOOLEAN NOT NULL DEFAULT false,
    "sharing_consented_at" TIMESTAMPTZ(6),
    "sharing_consent_version" VARCHAR(50),
    "sharing_revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_resume_pkey" PRIMARY KEY ("resume_id")
);

-- CreateTable
CREATE TABLE "user_provider_configuration" (
    "user_provider_configuration_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider_type" VARCHAR(20) NOT NULL,
    "provider_name" VARCHAR(120) NOT NULL,
    "base_url" VARCHAR(2048),
    "encrypted_api_key" BYTEA,
    "encryption_key_version" VARCHAR(30),
    "capabilities_json" JSONB NOT NULL,
    "credential_status" VARCHAR(20) NOT NULL DEFAULT 'unvalidated',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "configuration_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_provider_configuration_pkey" PRIMARY KEY ("user_provider_configuration_id")
);

-- CreateTable
CREATE TABLE "interview_category" (
    "category_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_code" VARCHAR(30) NOT NULL,
    "category_name" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" SMALLINT NOT NULL DEFAULT 0,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interview_category_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "interview_question_template" (
    "template_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID NOT NULL,
    "template_code" VARCHAR(80) NOT NULL,
    "template_name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "template_content" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interview_question_template_pkey" PRIMARY KEY ("template_id")
);

-- CreateTable
CREATE TABLE "interview_session" (
    "session_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "job_role" VARCHAR(150) NOT NULL,
    "job_description" TEXT,
    "category_id" UUID NOT NULL,
    "category_code_snapshot" VARCHAR(30) NOT NULL,
    "category_name_snapshot" VARCHAR(80) NOT NULL,
    "question_template_id" UUID,
    "evaluation_mode" VARCHAR(20) NOT NULL,
    "runtime_mode" VARCHAR(30) NOT NULL,
    "provider_route_snapshot" JSONB NOT NULL,
    "interviewer_prompt_version" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'created',
    "failure_code" VARCHAR(60),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interview_session_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "conversation_message" (
    "message_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "assessment_unit_id" UUID,
    "sequence_number" INTEGER NOT NULL,
    "speaker_type" VARCHAR(20) NOT NULL,
    "message_kind" VARCHAR(30) NOT NULL,
    "content_text" TEXT NOT NULL,
    "candidate_input_mode" VARCHAR(20),
    "idempotency_key" VARCHAR(100),

    CONSTRAINT "conversation_message_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "interview_assessment_unit" (
    "assessment_unit_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "unit_number" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_assessment_unit_pkey" PRIMARY KEY ("assessment_unit_id")
);

-- CreateTable
CREATE TABLE "interview_evaluation" (
    "evaluation_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "scorer_configuration_id" UUID,
    "scorer_provider_name_snapshot" VARCHAR(120) NOT NULL,
    "scorer_model_id" VARCHAR(150) NOT NULL,
    "rubric_version" VARCHAR(50) NOT NULL,
    "prompt_version" VARCHAR(50) NOT NULL,
    "evaluation_status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "interview_summary" TEXT,
    "overall_score" DECIMAL(3,2),
    "strengths_json" JSONB,
    "improvement_areas_json" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(60),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interview_evaluation_pkey" PRIMARY KEY ("evaluation_id")
);

-- CreateTable
CREATE TABLE "answer_evaluation" (
    "answer_evaluation_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "evaluation_id" UUID NOT NULL,
    "assessment_unit_id" UUID NOT NULL,
    "overall_score" DECIMAL(3,2) NOT NULL,
    "feedback_text" TEXT NOT NULL,
    "recommended_answer" TEXT NOT NULL,
    "strengths_json" JSONB NOT NULL,
    "improvement_areas_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "answer_evaluation_pkey" PRIMARY KEY ("answer_evaluation_id")
);

-- CreateTable
CREATE TABLE "evaluation_criterion_score" (
    "answer_evaluation_id" UUID NOT NULL,
    "criterion_code" VARCHAR(50) NOT NULL,
    "criterion_label_snapshot" VARCHAR(100) NOT NULL,
    "score_value" SMALLINT NOT NULL,
    "max_score" SMALLINT NOT NULL,
    "weight_snapshot" DECIMAL(5,4) NOT NULL,
    "evidence_text" TEXT,
    "rationale" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_criterion_score_pkey" PRIMARY KEY ("answer_evaluation_id","criterion_code")
);

-- CreateTable
CREATE TABLE "media_recording" (
    "recording_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "media_type" VARCHAR(30) NOT NULL,
    "storage_key" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "file_size_bytes" BIGINT,
    "duration_seconds" INTEGER,
    "consented_at" TIMESTAMPTZ(6) NOT NULL,
    "consent_version" VARCHAR(50) NOT NULL,
    "recording_started_at" TIMESTAMPTZ(6) NOT NULL,
    "recording_completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "deletion_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_recording_pkey" PRIMARY KEY ("recording_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account"("email");

-- CreateIndex
CREATE INDEX "candidate_resume_profile_user_id_idx" ON "candidate_resume"("profile_user_id");

-- CreateIndex
CREATE INDEX "user_provider_configuration_user_id_idx" ON "user_provider_configuration"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_category_category_code_key" ON "interview_category"("category_code");

-- CreateIndex
CREATE INDEX "interview_question_template_category_id_idx" ON "interview_question_template"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_question_template_template_code_version_number_key" ON "interview_question_template"("template_code", "version_number");

-- CreateIndex
CREATE INDEX "interview_session_user_id_created_at_idx" ON "interview_session"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "interview_session_category_id_idx" ON "interview_session"("category_id");

-- CreateIndex
CREATE INDEX "interview_session_question_template_id_idx" ON "interview_session"("question_template_id");

-- CreateIndex
CREATE INDEX "conversation_message_assessment_unit_id_idx" ON "conversation_message"("assessment_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_message_session_id_sequence_number_key" ON "conversation_message"("session_id", "sequence_number");

-- CreateIndex
CREATE UNIQUE INDEX "interview_assessment_unit_session_id_unit_number_key" ON "interview_assessment_unit"("session_id", "unit_number");

-- CreateIndex
CREATE UNIQUE INDEX "interview_evaluation_session_id_key" ON "interview_evaluation"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "answer_evaluation_assessment_unit_id_key" ON "answer_evaluation"("assessment_unit_id");

-- CreateIndex
CREATE INDEX "answer_evaluation_evaluation_id_idx" ON "answer_evaluation"("evaluation_id");

-- CreateIndex
CREATE INDEX "media_recording_session_id_idx" ON "media_recording"("session_id");

-- AddForeignKey
ALTER TABLE "candidate_profile" ADD CONSTRAINT "candidate_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resume" ADD CONSTRAINT "candidate_resume_profile_user_id_fkey" FOREIGN KEY ("profile_user_id") REFERENCES "candidate_profile"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_provider_configuration" ADD CONSTRAINT "user_provider_configuration_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_category" ADD CONSTRAINT "interview_category_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user_account"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_category" ADD CONSTRAINT "interview_category_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user_account"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_question_template" ADD CONSTRAINT "interview_question_template_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "interview_category"("category_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_question_template" ADD CONSTRAINT "interview_question_template_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user_account"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_question_template" ADD CONSTRAINT "interview_question_template_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user_account"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_session" ADD CONSTRAINT "interview_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_session" ADD CONSTRAINT "interview_session_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "interview_category"("category_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_session" ADD CONSTRAINT "interview_session_question_template_id_fkey" FOREIGN KEY ("question_template_id") REFERENCES "interview_question_template"("template_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "interview_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_assessment_unit_id_fkey" FOREIGN KEY ("assessment_unit_id") REFERENCES "interview_assessment_unit"("assessment_unit_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_assessment_unit" ADD CONSTRAINT "interview_assessment_unit_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "interview_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_evaluation" ADD CONSTRAINT "interview_evaluation_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "interview_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_evaluation" ADD CONSTRAINT "interview_evaluation_scorer_configuration_id_fkey" FOREIGN KEY ("scorer_configuration_id") REFERENCES "user_provider_configuration"("user_provider_configuration_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_evaluation" ADD CONSTRAINT "answer_evaluation_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "interview_evaluation"("evaluation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_evaluation" ADD CONSTRAINT "answer_evaluation_assessment_unit_id_fkey" FOREIGN KEY ("assessment_unit_id") REFERENCES "interview_assessment_unit"("assessment_unit_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_criterion_score" ADD CONSTRAINT "evaluation_criterion_score_answer_evaluation_id_fkey" FOREIGN KEY ("answer_evaluation_id") REFERENCES "answer_evaluation"("answer_evaluation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_recording" ADD CONSTRAINT "media_recording_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "interview_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------
-- AIMIS value-domain CHECK constraints and partial unique indexes.
-- Derived from the approved requirements (FR-AUTH-004, FR-SETUP-003/004/005,
-- FR-ASYNC-005/007, FR-PROFILE-005/006, FR-EVAL-008, NFR-REL-002) and
-- validated in the dictionary's VARCHAR columns. See schema header comment.
-- ------------------------------------------------------------------

-- user_account: exactly one access role; lifecycle status domain; the deletion
-- deadline only exists once deletion was explicitly requested (7-day grace).
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_role_domain_chk" CHECK (account_role IN ('candidate', 'recruiter', 'administrator'));
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_status_domain_chk" CHECK (account_status IN ('active', 'pending_deletion', 'deactivated'));
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_deletion_window_chk" CHECK (deletion_deadline_at IS NULL OR deletion_requested_at IS NOT NULL);

-- candidate_profile: visibility domain (private by default at the column level).
ALTER TABLE "candidate_profile" ADD CONSTRAINT "candidate_profile_visibility_domain_chk" CHECK (visibility IN ('private', 'public'));

-- candidate_resume: consent state machine. Sharing requires an explicit consent
-- timestamp plus the consent notice version; a revoked resume is never shared.
ALTER TABLE "candidate_resume" ADD CONSTRAINT "candidate_resume_consent_chk" CHECK (
    (is_shared_with_recruiters = FALSE)
    OR (sharing_consented_at IS NOT NULL AND sharing_consent_version IS NOT NULL)
);
ALTER TABLE "candidate_resume" ADD CONSTRAINT "candidate_resume_revocation_chk" CHECK (
    sharing_revoked_at IS NULL OR is_shared_with_recruiters = FALSE
);

-- user_provider_configuration: preset/custom domain, credential validation
-- domain, encrypted keys always carry the master-key version they were
-- encrypted with, and custom connections must state their Base URL.
ALTER TABLE "user_provider_configuration" ADD CONSTRAINT "user_provider_configuration_type_domain_chk" CHECK (provider_type IN ('preset', 'custom'));
ALTER TABLE "user_provider_configuration" ADD CONSTRAINT "user_provider_configuration_credential_status_domain_chk" CHECK (credential_status IN ('unvalidated', 'valid', 'invalid'));
ALTER TABLE "user_provider_configuration" ADD CONSTRAINT "user_provider_configuration_key_version_chk" CHECK (encrypted_api_key IS NULL OR encryption_key_version IS NOT NULL);
ALTER TABLE "user_provider_configuration" ADD CONSTRAINT "user_provider_configuration_custom_base_url_chk" CHECK (provider_type <> 'custom' OR base_url IS NOT NULL);

-- interview_category: display order is a non-negative sequence position.
ALTER TABLE "interview_category" ADD CONSTRAINT "interview_category_display_order_chk" CHECK (display_order >= 0);

-- interview_question_template: version lifecycle domain, positive version
-- numbers, and at most one active version per stable template_code (partial
-- unique index; multiple retired versions of one template may coexist).
ALTER TABLE "interview_question_template" ADD CONSTRAINT "interview_question_template_status_domain_chk" CHECK (status IN ('draft', 'active', 'retired'));
ALTER TABLE "interview_question_template" ADD CONSTRAINT "interview_question_template_version_positive_chk" CHECK (version_number >= 1);
CREATE UNIQUE INDEX "interview_question_template_active_code_uniq_idx" ON "interview_question_template"("template_code") WHERE status = 'active';

-- interview_session: approved evaluation modes, mutually exclusive runtimes,
-- session lifecycle domain, and a session cannot complete before it started.
ALTER TABLE "interview_session" ADD CONSTRAINT "interview_session_evaluation_mode_domain_chk" CHECK (evaluation_mode IN ('supportive', 'balanced', 'rigorous'));
ALTER TABLE "interview_session" ADD CONSTRAINT "interview_session_runtime_mode_domain_chk" CHECK (runtime_mode IN ('preset_realtime', 'custom'));
ALTER TABLE "interview_session" ADD CONSTRAINT "interview_session_status_domain_chk" CHECK (status IN ('created', 'active', 'completed', 'failed'));
ALTER TABLE "interview_session" ADD CONSTRAINT "interview_session_lifecycle_chk" CHECK (completed_at IS NULL OR started_at IS NOT NULL);

-- conversation_message: speaker/kind/input-mode domains, an input mode only
-- exists on candidate messages, sequence numbers start at 1, and retried
-- finalized submissions are deduplicated per session via a partial unique
-- index on the idempotency key (NFR-REL-002).
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_speaker_domain_chk" CHECK (speaker_type IN ('interviewer', 'candidate'));
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_kind_domain_chk" CHECK (message_kind IN ('primary_question', 'follow_up_question', 'candidate_response', 'acknowledgement'));
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_input_mode_domain_chk" CHECK (candidate_input_mode IS NULL OR candidate_input_mode IN ('text', 'voice'));
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_input_mode_speaker_chk" CHECK (candidate_input_mode IS NULL OR speaker_type = 'candidate');
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_sequence_positive_chk" CHECK (sequence_number >= 1);
CREATE UNIQUE INDEX "conversation_message_session_idempotency_key_uniq_idx" ON "conversation_message"("session_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

-- interview_assessment_unit: open/closed lifecycle; a closed unit always has
-- a closed_at timestamp and an open unit never does.
ALTER TABLE "interview_assessment_unit" ADD CONSTRAINT "interview_assessment_unit_status_domain_chk" CHECK (status IN ('open', 'closed'));
ALTER TABLE "interview_assessment_unit" ADD CONSTRAINT "interview_assessment_unit_lifecycle_chk" CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed'));
ALTER TABLE "interview_assessment_unit" ADD CONSTRAINT "interview_assessment_unit_number_positive_chk" CHECK (unit_number >= 1);

-- interview_evaluation: job-status domain (queued | processing | completed |
-- failed, FR-ASYNC-005), the consolidated weighted score stays on the approved
-- 1-5 scale, attempts are non-negative, and completion is only recorded for a
-- completed evaluation.
ALTER TABLE "interview_evaluation" ADD CONSTRAINT "interview_evaluation_status_domain_chk" CHECK (evaluation_status IN ('queued', 'processing', 'completed', 'failed'));
ALTER TABLE "interview_evaluation" ADD CONSTRAINT "interview_evaluation_overall_score_range_chk" CHECK (overall_score IS NULL OR (overall_score >= 1 AND overall_score <= 5));
ALTER TABLE "interview_evaluation" ADD CONSTRAINT "interview_evaluation_attempts_chk" CHECK (attempt_count >= 0);
ALTER TABLE "interview_evaluation" ADD CONSTRAINT "interview_evaluation_completed_chk" CHECK (completed_at IS NULL OR evaluation_status = 'completed');

-- answer_evaluation: one evaluation result per assessment unit; the weighted
-- answer score stays on the approved 1-5 scale.
ALTER TABLE "answer_evaluation" ADD CONSTRAINT "answer_evaluation_overall_score_range_chk" CHECK (overall_score >= 1 AND overall_score <= 5);

-- evaluation_criterion_score: integer 1-5 anchored scores, a bounded rubric
-- maximum, a positive weight snapshot, and a score never above its maximum.
ALTER TABLE "evaluation_criterion_score" ADD CONSTRAINT "evaluation_criterion_score_value_range_chk" CHECK (score_value BETWEEN 1 AND 5);
ALTER TABLE "evaluation_criterion_score" ADD CONSTRAINT "evaluation_criterion_score_max_range_chk" CHECK (max_score BETWEEN 1 AND 5);
ALTER TABLE "evaluation_criterion_score" ADD CONSTRAINT "evaluation_criterion_score_weight_chk" CHECK (weight_snapshot > 0 AND weight_snapshot <= 1);
ALTER TABLE "evaluation_criterion_score" ADD CONSTRAINT "evaluation_criterion_score_score_le_max_chk" CHECK (score_value <= max_score);

-- media_recording (deferred scope, schema present for the approved lifecycle):
-- object-deletion lifecycle domain.
ALTER TABLE "media_recording" ADD CONSTRAINT "media_recording_deletion_status_domain_chk" CHECK (deletion_status IN ('pending', 'removed', 'failed'));
