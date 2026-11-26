-- Scheduled interview state + revocable invitation links (TT-21; FR-SETUP-007/008).
-- The status domain keeps 'created' for sessions made before this migration;
-- interviews created now start as 'scheduled' and never auto-start.

ALTER TABLE "interview_session" DROP CONSTRAINT "interview_session_status_domain_chk";
ALTER TABLE "interview_session"
  ADD CONSTRAINT "interview_session_status_domain_chk"
  CHECK (status IN ('created', 'scheduled', 'active', 'completed', 'failed'));

ALTER TABLE "interview_session" ALTER COLUMN "status" SET DEFAULT 'scheduled';

ALTER TABLE "interview_session" ADD COLUMN "invitation_token_hash" VARCHAR(64);
ALTER TABLE "interview_session" ADD COLUMN "invitation_revoked_at" TIMESTAMPTZ(6);

-- One active link per interview; NULL hashes (revoked/never issued) are unconstrained.
CREATE UNIQUE INDEX "interview_session_invitation_token_hash_key"
  ON "interview_session"("invitation_token_hash");
