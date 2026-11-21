-- AlterTable
ALTER TABLE "interview_session" ADD COLUMN     "experience_level" VARCHAR(120),
ADD COLUMN     "question_count" INTEGER,
ADD COLUMN     "tech_stack" JSONB;
