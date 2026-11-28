import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

const dispatchMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve(true);
  }),
);
vi.mock("@/lib/livekit/env", () => ({
  getLiveKitConfig: () => ({ url: "wss://example.livekit.cloud", apiKey: "key", apiSecret: "secret" }),
}));
vi.mock("@/lib/interview/livekit-token", () => ({
  mintParticipantToken: vi.fn(async () => ({ url: "wss://example.livekit.cloud", token: "jwt" })),
}));
vi.mock("@/lib/interview/livekit-dispatch", () => ({
  dispatchGeneratorAgent: dispatchMock,
  AIMIS_AGENT_NAME: "aimis-agent",
}));

import { createProviderConfiguration, setActiveRuntimeMode } from "@/lib/providers/config";
import {
  completeGeneration,
  confirmGeneration,
  GenerationError,
  getGeneration,
  postCaption,
  startGeneration,
} from "./generation";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const d = describe.skipIf(!TEST_DATABASE_URL);

async function makeUser(): Promise<string> {
  const account = await db.userAccount.create({
    data: {
      email: `voice-gen-${randomUUID()}@example.com`,
      passwordHash: "argon2id-test-hash",
      accountRole: "candidate",
    },
  });
  return account.userId;
}

d("voice interview generation (integration)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("carries a worker-only capability through to captioning and interview creation", async () => {
    const userId = await makeUser();
    await createProviderConfiguration(userId, {
      providerType: "custom",
      providerName: "gen-llm",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      capabilities: { llm: { modelId: "test-model" } },
    });
    await setActiveRuntimeMode(userId, "custom");
    await db.interviewCategory.upsert({
      where: { categoryCode: "technical" },
      create: { categoryCode: "technical", categoryName: "Technical" },
      update: { isActive: true },
    });

    dispatchMock.mockClear();
    const started = await startGeneration(userId);
    expect(started.id).toBeTruthy();
    expect(started.token).toBe("jwt");
    const meta = dispatchMock.mock.calls[0]?.[0] as { generationId: string; workerToken: string };
    expect(meta.generationId).toBe(started.id);
    const workerToken = meta.workerToken;
    expect(workerToken).toBeTruthy();

    expect((await getGeneration(userId, started.id)).status).toBe("collecting");

    await expect(postCaption(started.id, "wrong-token", { speaker: "agent", text: "hello" }))
      .rejects.toBeInstanceOf(GenerationError);
    await postCaption(started.id, workerToken, { speaker: "agent", text: "What role?" });
    expect((await getGeneration(userId, started.id)).caption?.text).toBe("What role?");

    const config = {
      role: "Frontend Engineer",
      type: "technical",
      level: "Mid level",
      techstack: "React, TypeScript",
      amount: "5",
      strictness: "Balanced",
    };
    const first = await completeGeneration(started.id, workerToken, config);
    expect(first.invitationPath).toMatch(/^\/interview\//);
    // The generation id must reach session creation as the idempotency key.
    const created = await db.interviewSession.findFirst({
      where: { creationIdempotencyKey: started.id },
    });
    expect(created).not.toBeNull();
    const second = await completeGeneration(started.id, workerToken, config);
    expect(second.invitationPath).toBe(first.invitationPath);

    const done = await getGeneration(userId, started.id);
    expect(done.status).toBe("completed");
    expect(done.invitationPath).toBe(first.invitationPath);
    expect(done.config?.jobRole).toBe("Frontend Engineer");
    expect(done.config?.strictness).toBe("balanced");

    const confirmed = await confirmGeneration(userId, started.id, {
      ...done.config!,
      experienceLevel: "Senior",
      strictness: "rigorous",
      techStack: ["React"],
    });
    expect(confirmed.invitationPath).toBe(first.invitationPath);
    const afterConfirm = await getGeneration(userId, started.id);
    expect(afterConfirm.status).toBe("confirmed");
    expect(afterConfirm.config?.strictness).toBe("rigorous");

    await db.userAccount.delete({ where: { userId } });
  });

  it("replays a same-config confirmation when another request wins the claim", async () => {
    const userId = await makeUser();
    await createProviderConfiguration(userId, {
      providerType: "custom",
      providerName: "gen-llm",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      capabilities: { llm: { modelId: "test-model" } },
    });
    await setActiveRuntimeMode(userId, "custom");
    await db.interviewCategory.upsert({
      where: { categoryCode: "technical" },
      create: { categoryCode: "technical", categoryName: "Technical" },
      update: { isActive: true },
    });

    dispatchMock.mockClear();
    const started = await startGeneration(userId);
    const meta = dispatchMock.mock.calls[0]?.[0] as { workerToken: string };
    await completeGeneration(started.id, meta.workerToken, {
      role: "Backend Engineer",
      type: "technical",
      level: "Senior",
      techstack: "Node.js",
      amount: "5",
      strictness: "Balanced",
    });
    const done = await getGeneration(userId, started.id);
    const input = { ...done.config!, techStack: ["Node.js"] };
    const first = await confirmGeneration(userId, started.id, input);

    // Simulate a concurrent caller that read the pre-confirmation row before
    // the winner committed: only the outer owner-scoped read is stale, so the
    // conditional claim loses and the in-transaction re-read must replay.
    const stale = await db.interviewGeneration.findUniqueOrThrow({ where: { id: started.id } });
    const findFirst = vi.spyOn(db.interviewGeneration, "findFirst")
      .mockResolvedValueOnce({ ...stale, status: "completed" });
    try {
      const replayed = await confirmGeneration(userId, started.id, input);
      expect(replayed.invitationPath).toBe(first.invitationPath);
      expect(replayed.sessionId).toBe(first.sessionId);
    } finally {
      findFirst.mockRestore();
    }

    await db.userAccount.delete({ where: { userId } });
  });
});
