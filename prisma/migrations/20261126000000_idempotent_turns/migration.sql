-- Idempotent interview creation + one-open-unit invariant (PR #7 review fixes).
-- The candidate-supplied creation key is unique per candidate: a retried
-- "create" request maps to the same session instead of a duplicate. NULL keys
-- (server-internal / pre-existing sessions) are unconstrained, as in the
-- conversation_message idempotency index.
ALTER TABLE "interview_session" ADD COLUMN "creation_idempotency_key" VARCHAR(100);

CREATE UNIQUE INDEX "interview_session_user_id_creation_idempotency_key_key"
  ON "interview_session"("user_id", "creation_idempotency_key")
  WHERE "creation_idempotency_key" IS NOT NULL;

-- The turn engine closes the current unit before opening the next; this
-- database-level invariant rejects any concurrent attempt to leave two open
-- units for the same session (defence in depth over the application check).
CREATE UNIQUE INDEX "interview_assessment_unit_one_open_per_session"
  ON "interview_assessment_unit"("session_id")
  WHERE "status" = 'open';
