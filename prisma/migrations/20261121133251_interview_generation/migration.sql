-- CreateTable
CREATE TABLE "interview_generation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "room_name" VARCHAR(120) NOT NULL,
    "worker_token_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'collecting',
    "caption_json" JSONB,
    "config_json" JSONB,
    "invitation_path" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interview_generation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "interview_generation_room_name_key" ON "interview_generation"("room_name");

-- CreateIndex
CREATE INDEX "interview_generation_user_id_created_at_idx" ON "interview_generation"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "interview_generation" ADD CONSTRAINT "interview_generation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
