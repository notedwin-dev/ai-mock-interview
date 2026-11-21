import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { createProviderConfiguration } from "@/lib/providers/config";
import { hashInvitationToken } from "./invitation-token";
import { resolveInvitation } from "./invitations";
import {
  createInterviewSession,
  endInterviewSession,
  getOwnInterviewTranscript,
  INTERVIEWER_PROMPT_VERSION,
  InterviewError,
  listActiveInterviewCategories,
  startInterviewSession,
  submitTypedTurn,
} from "./service";

/**
 * Integration tests for the typed vertical slice (backlog slice 7) against
 * the dedicated TEST_DATABASE_URL database (docs/TESTING.md). Skipped when
 * the variable is unset so `pnpm test` stays hermetic.
 *
 * Categories are created per test: the suite truncates the tables it
 * touches, so it never depends on (nor destroys) the migration-seeded
 * reference data.
 */

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const d = describe.skipIf(!TEST_DATABASE_URL);

const TABLES = [
  `"user_account"`,
  `"user_provider_configuration"`,
  `"interview_category"`,
  `"interview_session"`,
  `"conversation_message"`,
];

let db: PrismaClient;

d("interview session service (integration)", () => {
  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }) });
    process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");
    process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "vtest";
  });

  afterAll(async () => {
    await db.$disconnect();
    delete process.env["PROVIDER_ENCRYPTION_MASTER_KEY"];
    delete process.env["PROVIDER_ENCRYPTION_KEY_VERSION"];
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
  });

  afterEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
  });

  let userSeq = 0;
  async function createUser(): Promise<string> {
    const account = await db.userAccount.create({
      data: {
        email: `interview-${Date.now().toString(36)}-${++userSeq}@example.com`,
        passwordHash: "argon2id-test-hash",
        accountRole: "candidate",
      },
    });
    return account.userId;
  }

  async function createCategory(code = "general", name = "General"): Promise<string> {
    const category = await db.interviewCategory.create({
      data: { categoryCode: code, categoryName: name, displayOrder: 1 },
    });
    return category.categoryId;
  }

  /** The M1 exit path requires a provider with an LLM capability. */
  async function createLlmConfig(userId: string): Promise<void> {
    await createProviderConfiguration(userId, {
      providerType: "custom",
      providerName: "test-endpoint",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-plaintext-secret",
      capabilities: { llm: { modelId: "test-model-1" } },
    });
  }

  const setupInput = (categoryId: string) => ({
    jobRole: "Backend Engineer",
    jobDescription: "Build REST APIs.",
    categoryId,
    evaluationMode: "balanced",
    runtimeMode: "custom",
  });

  async function createStartedSession(userId: string): Promise<{
    sessionId: string;
    categoryId: string;
  }> {
    await createLlmConfig(userId);
    const categoryId = await createCategory();
    const session = await createInterviewSession(userId, setupInput(categoryId));
    await startInterviewSession(userId, session.sessionId);
    return { sessionId: session.sessionId, categoryId };
  }

  it("lists active categories ordered by display order", async () => {
    await db.interviewCategory.create({
      data: { categoryCode: "technical", categoryName: "Technical", displayOrder: 2 },
    });
    const general = await db.interviewCategory.create({
      data: { categoryCode: "general", categoryName: "General", displayOrder: 1 },
    });
    await db.interviewCategory.create({
      data: { categoryCode: "retired", categoryName: "Retired", isActive: false, displayOrder: 0 },
    });

    const categories = await listActiveInterviewCategories();
    expect(categories.map((c) => c.categoryCode)).toEqual(["general", "technical"]);
    expect(categories[0]!.categoryId).toBe(general.categoryId);
  });

  it("creates a session with snapshot fields and a key-free provider route", async () => {
    const userId = await createUser();
    await createLlmConfig(userId);
    const categoryId = await createCategory();

    const session = await createInterviewSession(userId, setupInput(categoryId));
    expect(session.status).toBe("scheduled");
    // Each scheduled interview carries a ready-to-share, working invitation.
    expect(session.invitation.path).toBe(`/i/${session.invitation.token}`);
    const resolved = await resolveInvitation(session.invitation.token);
    expect(resolved).toMatchObject({ sessionId: session.sessionId, status: "scheduled" });
    const storedRow = await db.interviewSession.findUniqueOrThrow({ where: { sessionId: session.sessionId } });
    expect(storedRow.invitationTokenHash).toBe(hashInvitationToken(session.invitation.token));
    expect(session.startedAt).toBeNull();
    expect(session.categoryCodeSnapshot).toBe("general");
    expect(session.categoryNameSnapshot).toBe("General");
    expect(session.evaluationMode).toBe("balanced");
    expect(session.runtimeMode).toBe("custom");
    expect(session.interviewerPromptVersion).toBe(INTERVIEWER_PROMPT_VERSION);

    // The snapshot identifies the route but never carries the credential.
    const snapshot = session.providerRouteSnapshot;
    expect(Object.keys(snapshot).sort()).toEqual([
      "baseUrl",
      "capability",
      "modelId",
      "providerName",
      "providerType",
    ]);
    expect(snapshot.modelId).toBe("test-model-1");

    const row = await db.interviewSession.findUnique({ where: { sessionId: session.sessionId } });
    expect(row?.providerRouteSnapshot).toBeTruthy();
  });

  it("creates a realtime session with only a realtime agent configured", async () => {
    const userId = await createUser();
    const realtime = await createProviderConfiguration(userId, {
      providerType: "preset",
      providerName: "google",
      apiKey: "sk-plaintext-secret",
      capabilities: { realtime: { modelId: "gemini-3.8-live-extended-thinking" } },
    });
    // A realtime interview only launches on a probed credential.
    await db.userProviderConfiguration.update({
      where: { userProviderConfigurationId: realtime.userProviderConfigurationId },
      data: { credentialStatus: "valid" },
    });
    const categoryId = await createCategory();

    const session = await createInterviewSession(userId, setupInput(categoryId));
    expect(session.runtimeMode).toBe("preset_realtime");
    expect(session.providerRouteSnapshot).toMatchObject({
      capability: "realtime",
      modelId: "gemini-3.8-live-extended-thinking",
    });
  });

  it("fails session creation when no enabled LLM-capable provider exists", async () => {
    const userId = await createUser();
    const categoryId = await createCategory();
    await expect(createInterviewSession(userId, setupInput(categoryId))).rejects.toMatchObject({
      code: "provider_route_missing",
    });
    expect(await db.interviewSession.count()).toBe(0);
  });

  it("rejects unknown or inactive categories at creation", async () => {
    const userId = await createUser();
    await createLlmConfig(userId);
    await expect(
      createInterviewSession(userId, setupInput("11111111-1111-4111-8111-111111111111")),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const inactive = await db.interviewCategory.create({
      data: { categoryCode: "off", categoryName: "Off", isActive: false },
    });
    await expect(
      createInterviewSession(userId, setupInput(inactive.categoryId)),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("runs the lifecycle scheduled → active → completed with timestamps", async () => {
    const userId = await createUser();
    await createLlmConfig(userId);
    const categoryId = await createCategory();
    const session = await createInterviewSession(userId, setupInput(categoryId));

    const started = await startInterviewSession(userId, session.sessionId);
    expect(started.status).toBe("active");
    expect(started.startedAt).not.toBeNull();
    expect(started.completedAt).toBeNull();

    const ended = await endInterviewSession(userId, session.sessionId);
    expect(ended.status).toBe("completed");
    expect(ended.completedAt).not.toBeNull();

    // FR-INTERVIEW-011: a repeated end request is idempotent — it returns the
    // stored completion instead of creating a second completion event.
    const repeated = await endInterviewSession(userId, session.sessionId);
    expect(repeated.status).toBe("completed");
    expect(repeated.completedAt).toBe(ended.completedAt);
  });

  it("enforces the state machine: no double start, no end before start", async () => {
    const userId = await createUser();
    await createLlmConfig(userId);
    const categoryId = await createCategory();
    const session = await createInterviewSession(userId, setupInput(categoryId));

    await expect(submitTypedTurn(userId, session.sessionId, {
      contentText: "early",
      inputMode: "text",
    })).rejects.toMatchObject({ code: "invalid_state" });

    await expect(endInterviewSession(userId, session.sessionId)).rejects.toMatchObject({
      code: "invalid_state",
    });

    await startInterviewSession(userId, session.sessionId);
    await expect(startInterviewSession(userId, session.sessionId)).rejects.toMatchObject({
      code: "invalid_state",
    });

    await endInterviewSession(userId, session.sessionId);
    await expect(
      submitTypedTurn(userId, session.sessionId, { contentText: "late", inputMode: "text" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("persists typed turns chronologically and returns the transcript", async () => {
    const userId = await createUser();
    const { sessionId } = await createStartedSession(userId);

    const first = await submitTypedTurn(userId, sessionId, {
      contentText: "First response.",
      inputMode: "text",
    });
    expect(first.created).toBe(true);
    expect(first.message.sequenceNumber).toBe(1);
    expect(first.message.speakerType).toBe("candidate");
    expect(first.message.messageKind).toBe("candidate_response");
    expect(first.message.candidateInputMode).toBe("text");

    const second = await submitTypedTurn(userId, sessionId, {
      contentText: "Second response.",
      inputMode: "text",
    });
    expect(second.message.sequenceNumber).toBe(2);

    const transcript = await getOwnInterviewTranscript(userId, sessionId);
    expect(transcript.messages.map((m) => m.contentText)).toEqual([
      "First response.",
      "Second response.",
    ]);
    expect(transcript.messages.map((m) => m.sequenceNumber)).toEqual([1, 2]);
    expect(transcript.session.status).toBe("active");
  });

  it("a retried submission with the same idempotency key returns the original message", async () => {
    const userId = await createUser();
    const { sessionId } = await createStartedSession(userId);

    const original = await submitTypedTurn(userId, sessionId, {
      contentText: "Only once.",
      inputMode: "text",
      idempotencyKey: "turn-1",
    });
    const retried = await submitTypedTurn(userId, sessionId, {
      contentText: "Only once.",
      inputMode: "text",
      idempotencyKey: "turn-1",
    });

    expect(retried.created).toBe(false);
    expect(retried.message.messageId).toBe(original.message.messageId);
    expect(await db.conversationMessage.count({ where: { sessionId } })).toBe(1);
  });

  it("different idempotency keys create distinct turns with rising sequences", async () => {
    const userId = await createUser();
    const { sessionId } = await createStartedSession(userId);

    await submitTypedTurn(userId, sessionId, {
      contentText: "one", inputMode: "text", idempotencyKey: "a1",
    });
    const second = await submitTypedTurn(userId, sessionId, {
      contentText: "two", inputMode: "text", idempotencyKey: "b2",
    });
    expect(second.created).toBe(true);
    expect(second.message.sequenceNumber).toBe(2);
  });

  it("session ownership is scoped: foreign sessions look like missing ones", async () => {
    const owner = await createUser();
    const outsider = await createUser();
    await createLlmConfig(outsider);
    const { sessionId } = await createStartedSession(owner);

    await expect(getOwnInterviewTranscript(outsider, sessionId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      submitTypedTurn(outsider, sessionId, { contentText: "hi", inputMode: "text" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(endInterviewSession(outsider, sessionId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects malformed turn payloads without writing rows", async () => {
    const userId = await createUser();
    const { sessionId } = await createStartedSession(userId);

    await expect(
      submitTypedTurn(userId, sessionId, { contentText: "", inputMode: "text" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      submitTypedTurn(userId, sessionId, { contentText: "ok", inputMode: "text", extra: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await db.conversationMessage.count({ where: { sessionId } })).toBe(0);
  });

  it("keeps InterviewError distinct with stable codes", () => {
    const error = new InterviewError("invalid_state", "nope");
    expect(error.name).toBe("InterviewError");
    expect(error.code).toBe("invalid_state");
  });
});
