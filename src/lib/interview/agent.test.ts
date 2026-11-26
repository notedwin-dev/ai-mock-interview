import { describe, expect, it, vi } from "vitest";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import {
  agentTurnInputSchema,
  createInterviewFromAgentConfig,
  runAgentTurn,
  type AgentLlmOutput,
} from "./agent";

/**
 * Hermetic tests for the AI Interview Agent (FR-SETUP-006). The LLM and the
 * provider-route resolver are replaced at the public seams; no network and
 * no database are involved. Category codes and modes are the approved ones
 * from the seeded reference data and evaluation design.
 */
const USER_ID = "33333333-3333-4333-8333-333333333333";
const route: ProviderRoute = {
  providerName: "openai",
  providerType: "preset",
  baseUrl: "https://api.example.com/v1",
  modelId: "exact-agent-model",
  apiKey: "sk-secret",
};

const llmOutput: AgentLlmOutput = {
  reply: "Which role are you preparing for?",
  missingFields: ["jobRole"],
  config: null,
};

describe("runAgentTurn", () => {
  it("uses the configured LLM route and returns the agent's validated conversational reply", async () => {
    const resolveRoute = vi.fn(async () => route);
    const generate = vi.fn(async (_route: ProviderRoute, options: { instructions: string; prompt: string }) => {
      expect(options.instructions).toContain("purpose");
      expect(options.instructions).toContain("job description");
      expect(options.instructions).toContain("strictness");
      expect(options.instructions).toContain("Supportive");
      expect(options.instructions).toContain("Balanced");
      expect(options.instructions).toContain("Rigorous");
      expect(options.prompt).toContain("I want interview practice");
      return llmOutput;
    });

    const result = await runAgentTurn(
      USER_ID,
      { messages: [{ role: "candidate", content: "I want interview practice" }] },
      { resolveRoute, generate: generate as never },
    );

    expect(resolveRoute).toHaveBeenCalledWith(USER_ID);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("Which role are you preparing for?");
    expect(result.missingFields).toEqual(["jobRole"]);
    expect(result.config).toBeNull();
  });

  it("never exposes a generated config while required fields are still missing", async () => {
    const generate = vi.fn(async () => ({
      reply: "What job description should I use?",
      missingFields: ["jobDescription"],
      config: {
        purpose: "practice",
        jobRole: "Engineer",
        jobDescription: "",
        strictness: "balanced",
        category: "technical",
      },
    }));

    const result = await runAgentTurn(USER_ID, { messages: [{ role: "candidate", content: "hi" }] }, {
      resolveRoute: async () => route,
      generate: generate as never,
    });

    expect(result.ready).toBe(false);
    expect(result.config).toBeNull();
  });

  it("rejects malformed conversation input before calling the provider", async () => {
    const resolveRoute = vi.fn(async () => route);
    const generate = vi.fn(async () => llmOutput);
    const base = { resolveRoute, generate: generate as never };

    expect(() => agentTurnInputSchema.parse({ messages: [] })).toThrow();
    expect(() =>
      agentTurnInputSchema.parse({
        messages: Array.from({ length: 13 }, () => ({ role: "candidate", content: "x" })),
      }),
    ).toThrow();
    expect(() =>
      agentTurnInputSchema.parse({ messages: [{ role: "system", content: "x" }] }),
    ).toThrow();
    expect(() =>
      agentTurnInputSchema.parse({ messages: [{ role: "candidate", content: "x".repeat(5001) }] }),
    ).toThrow();
    await expect(
      runAgentTurn(USER_ID, { messages: [] }, base),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("createInterviewFromAgentConfig", () => {
  const config = {
    purpose: "practice technical screens",
    jobRole: "Backend Engineer",
    jobDescription: "Design APIs in Node.js",
    strictness: "rigorous",
    category: "technical",
  } as const;

  it("maps strictness and category onto the existing session creation contract", async () => {
    const createSession = vi.fn(async () => ({ sessionId: "new-session" }) as never);
    const findCategory = vi.fn(async () => ({ categoryId: "category-uuid" }));

    const session = await createInterviewFromAgentConfig(
      USER_ID,
      { config, missingFields: [] },
      { findCategory, createSession },
    );

    expect(findCategory).toHaveBeenCalledWith("technical");
    expect(createSession).toHaveBeenCalledWith(USER_ID, {
      jobRole: "Backend Engineer",
      jobDescription: "Design APIs in Node.js",
      categoryId: "category-uuid",
      evaluationMode: "rigorous",
      runtimeMode: "custom",
    }, undefined);
    expect(session).toMatchObject({ sessionId: "new-session" });
  });

  it("replays an existing session before checking category availability", async () => {
    const existing = {
      sessionId: "existing-session",
      invitation: { token: "token", path: "/i/token" },
    };
    const findExisting = vi.fn(async () => existing as never);
    const findCategory = vi.fn(async () => null);
    const createSession = vi.fn(async () => ({ sessionId: "should-not-exist" }) as never);

    const session = await createInterviewFromAgentConfig(
      USER_ID,
      { config, missingFields: [], idempotencyKey: "create-1" },
      { findExisting, findCategory, createSession },
    );

    expect(findExisting).toHaveBeenCalledWith(USER_ID, "create-1");
    expect(findCategory).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(session).toBe(existing);
  });

  it("checks the category and creates when no session matches the key", async () => {
    const findExisting = vi.fn(async () => null);
    const findCategory = vi.fn(async () => ({ categoryId: "category-uuid" }));
    const createSession = vi.fn(async () => ({ sessionId: "new-session" }) as never);

    await createInterviewFromAgentConfig(
      USER_ID,
      { config, missingFields: [], idempotencyKey: "create-2" },
      { findExisting, findCategory, createSession },
    );

    expect(findExisting).toHaveBeenCalledWith(USER_ID, "create-2");
    expect(findCategory).toHaveBeenCalledWith("technical");
    expect(createSession).toHaveBeenCalledWith(USER_ID, expect.anything(), "create-2");
  });

  it("refuses to create anything while fields are missing", async () => {
    const createSession = vi.fn(async () => ({ sessionId: "should-not-exist" }) as never);

    await expect(
      createInterviewFromAgentConfig(
        USER_ID,
        { config, missingFields: ["strictness"] },
        { findCategory: async () => ({ categoryId: "category-uuid" }), createSession },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails closed when the category is inactive or unknown", async () => {
    const createSession = vi.fn(async () => ({ sessionId: "should-not-exist" }) as never);

    await expect(
      createInterviewFromAgentConfig(
        USER_ID,
        { config, missingFields: [] },
        { findCategory: async () => null, createSession },
      ),
    ).rejects.toMatchObject({ code: "category_unavailable" });
    expect(createSession).not.toHaveBeenCalled();
  });
});
