-- Candidate-owned planned start time. Informational only: joining still
-- controls when the interview actually starts.
ALTER TABLE "interview_session" ADD COLUMN "scheduled_at" TIMESTAMPTZ(6);

CREATE INDEX "interview_session_user_id_scheduled_at_idx" ON "interview_session"("user_id", "scheduled_at");
