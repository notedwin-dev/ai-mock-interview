import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { hashInvitationToken } from "./invitation-token";
import { issueInvitation, resolveInvitation, revokeInvitation } from "./invitations";
import { runRoomTurn } from "./room";

/**
 * Integration tests for revocable invitation links (TT-21, FR-SETUP-008)
 * against the dedicated TEST_DATABASE_URL database (docs/TESTING.md).
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const d = describe.skipIf(!TEST_DATABASE_URL);

const TABLES = ['"interview_session"', '"interview_category"', '"user_account"'];
let db: PrismaClient;
let ownerId: string;
let otherId: string;
let categoryId: string;

beforeAll(() => {
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }) });
});
afterAll(async () => { await db.$disconnect(); });
beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
  const suffix = randomBytes(6).toString("hex");
  const owner = await db.userAccount.create({
    data: { email: `owner-${suffix}@example.com`, passwordHash: "hash", accountRole: "candidate" },
  });
  const other = await db.userAccount.create({
    data: { email: `other-${suffix}@example.com`, passwordHash: "hash", accountRole: "candidate" },
  });
  const category = await db.interviewCategory.create({
    data: { categoryCode: `general_${suffix}`, categoryName: "General" },
  });
  ownerId = owner.userId; otherId = other.userId; categoryId = category.categoryId;
  process.env["PROVIDER_ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");
  process.env["PROVIDER_ENCRYPTION_KEY_VERSION"] = "vtest";
});
afterEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
});

async function makeSession(overrides: Record<string, unknown> = {}) {
  return db.interviewSession.create({
    data: {
      userId: ownerId,
      categoryId,
      jobRole: "Backend Engineer",
      jobDescription: "Design APIs",
      categoryCodeSnapshot: "general",
      categoryNameSnapshot: "General",
      evaluationMode: "balanced",
      runtimeMode: "custom",
      providerRouteSnapshot: {},
      interviewerPromptVersion: "v1",
      ...overrides,
    } as never,
  });
}

d("invitation links (TT-21)", () => {
  it("issues a link, stores only its hash, and marks the interview scheduled", async () => {
    const session = await makeSession();
    const issued = await issueInvitation(ownerId, session.sessionId);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.path).toBe(`/i/${issued.token}`);
    const stored = await db.interviewSession.findUniqueOrThrow({ where: { sessionId: session.sessionId } });
    expect(stored.invitationTokenHash).toBe(hashInvitationToken(issued.token));
    expect(stored.invitationTokenHash).not.toContain(issued.token);
    expect(stored.status).toBe("scheduled");
  });

  it("resolves only that interview's minimal confirmation details", async () => {
    const session = await makeSession();
    const issued = await issueInvitation(ownerId, session.sessionId);

    const view = await resolveInvitation(issued.token);
    expect(view).toEqual({
      sessionId: session.sessionId,
      jobRole: "Backend Engineer",
      jobDescription: "Design APIs",
      categoryNameSnapshot: "General",
      evaluationMode: "balanced",
      runtimeMode: "custom",
      status: "scheduled",
    });
    expect(await resolveInvitation(createToken())).toBeNull(); // unknown link
    expect(await resolveInvitation("not-a-token")).toBeNull();
  });

  it("revocation invalidates future access and is idempotent", async () => {
    const session = await makeSession();
    const issued = await issueInvitation(ownerId, session.sessionId);
    await revokeInvitation(ownerId, session.sessionId);
    await revokeInvitation(ownerId, session.sessionId);

    expect(await resolveInvitation(issued.token)).toBeNull();
    const stored = await db.interviewSession.findUniqueOrThrow({ where: { sessionId: session.sessionId } });
    expect(stored.invitationTokenHash).toBeNull();
    expect(stored.invitationRevokedAt).not.toBeNull();
  });

  it("reissuing replaces the old link", async () => {
    const session = await makeSession();
    const first = await issueInvitation(ownerId, session.sessionId);
    const second = await issueInvitation(ownerId, session.sessionId);

    expect(second.token).not.toBe(first.token);
    expect(await resolveInvitation(first.token)).toBeNull();
    expect((await resolveInvitation(second.token))?.sessionId).toBe(session.sessionId);
  });

  it("scopes issue and revoke to the owning candidate", async () => {
    const session = await makeSession();
    await expect(issueInvitation(otherId, session.sessionId)).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeInvitation(otherId, session.sessionId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("persists realtime messages in approved kinds and is idempotent on client ids", async () => {
    const session = await makeSession();
    const store = (await import("./room-store")).createDefaultRoomStore();
    const first = await store.appendRealtimeMessage(session.sessionId, "candidate", "my answer", "evt-c");
    const second = await store.appendRealtimeMessage(session.sessionId, "interviewer", "tell me more", "evt-i");
    const replay = await store.appendRealtimeMessage(session.sessionId, "candidate", "my answer", "evt-c");

    expect(first.messageKind).toBe("candidate_response");
    expect(second.messageKind).toBe("primary_question"); // approved message_kind domain
    expect(replay.sequenceNumber).toBe(first.sequenceNumber);
    expect(await db.conversationMessage.count({ where: { sessionId: session.sessionId } })).toBe(2);
  });

  it("runs a token-scoped turn against the real store: transcript, unit and active state", async () => {
    const session = await makeSession();
    const invitation = await issueInvitation(ownerId, session.sessionId);

    const result = await runRoomTurn(
      invitation.token,
      { contentText: "Here is my answer", idempotencyKey: "turn-1" },
      {
        // Provider seam only — persistence is the real default store.
        resolveRoute: async () => ({
          providerName: "openai", providerType: "preset", baseUrl: "https://x/v1",
          modelId: "m", apiKey: "k",
        }),
        generate: async () => ({
          interviewerText: "Tell me about a challenging problem you solved.",
          messageKind: "primary_question",
          endCall: false,
        }),
      },
    );

    expect(result.created).toBe(true);
    expect(result.messages.map((m) => m.speakerType)).toEqual(["candidate", "interviewer"]);
    expect(await db.conversationMessage.count({ where: { sessionId: session.sessionId } })).toBe(2);
    expect(await db.interviewAssessmentUnit.count({ where: { sessionId: session.sessionId } })).toBe(1);
    const stored = await db.interviewSession.findUniqueOrThrow({ where: { sessionId: session.sessionId } });
    expect(stored.status).toBe("active");
    expect(stored.startedAt).not.toBeNull();
  });
});

function createToken(): string {
  return randomBytes(32).toString("base64url");
}
