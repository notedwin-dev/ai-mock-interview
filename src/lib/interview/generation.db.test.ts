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
  GENERATOR_AGENT_NAME: "aimis-generator",
}));

import { createProviderConfiguration, setActiveRuntimeMode } from "@/lib/providers/config";
import {
  completeGeneration,
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
      purpose: "Practice a frontend interview",
      jobRole: "Frontend Engineer",
      jobDescription: "Mid level. React and TypeScript. 5 questions.",
      strictness: "balanced",
      category: "technical",
    };
    const first = await completeGeneration(started.id, workerToken, config);
    expect(first.invitationPath).toMatch(/^\/i\//);
    const second = await completeGeneration(started.id, workerToken, config);
    expect(second.invitationPath).toBe(first.invitationPath);

    const done = await getGeneration(userId, started.id);
    expect(done.status).toBe("completed");
    expect(done.invitationPath).toBe(first.invitationPath);

    await db.userAccount.delete({ where: { userId } });
  });
});
