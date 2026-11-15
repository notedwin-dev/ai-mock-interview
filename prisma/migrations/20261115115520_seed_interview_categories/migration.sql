-- Reference data for interview setup (FR-SETUP-003): the approved interview
-- categories. Admin-managed later (TT-7, deferred); seeded here so every
-- environment (dev, shadow, backup, test, future production) receives the
-- same baseline deterministically. Idempotent by category_code.
INSERT INTO "interview_category" ("category_id", "category_code", "category_name", "description", "is_active", "display_order", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'general', 'General', 'General interview questions covering motivation, background and fit.', TRUE, 1, NULL, NULL, now(), now()),
  (gen_random_uuid(), 'technical', 'Technical', 'Technical interview questions probing role-relevant skills and knowledge.', TRUE, 2, NULL, NULL, now(), now()),
  (gen_random_uuid(), 'behavioral', 'Behavioral', 'Behavioral interview questions about past situations and conduct.', TRUE, 3, NULL, NULL, now(), now())
ON CONFLICT ("category_code") DO NOTHING;
