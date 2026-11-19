import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "@/lib/ai/llm";
import { AgentError } from "@/lib/interview/agent";

const mocks = vi.hoisted(() => ({
  requireApiAccount: vi.fn(),
  runAgentTurn: vi.fn(),
  createInterviewFromAgentConfig: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({ requireApiAccount: mocks.requireApiAccount }));
vi.mock("@/lib/interview/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/interview/agent")>();
  return {
    ...actual,
    runAgentTurn: mocks.runAgentTurn,
    createInterviewFromAgentConfig: mocks.createInterviewFromAgentConfig,
  };
});

import { POST } from "./route";

const USER_ID = "33333333-3333-4333-8333-333333333333";

function request(body: unknown): Request {
  return new Request("http://localhost/api/v1/interviews/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/interviews/agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAccount.mockResolvedValue({ account: { userId: USER_ID } });
  });

  it("rejects unauthenticated callers", async () => {
    mocks.requireApiAccount.mockResolvedValue(null);
    const response = await POST(request({ action: "turn", messages: [{ role: "candidate", content: "hi" }] }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
  });

  it("runs a conversational turn through the agent service", async () => {
    const result = { reply: "What role?", missingFields: ["jobRole"], config: null, ready: false };
    mocks.runAgentTurn.mockResolvedValue(result);
    const response = await POST(request({
      action: "turn",
      messages: [{ role: "candidate", content: "I want practice" }],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result });
    expect(mocks.runAgentTurn).toHaveBeenCalledWith(USER_ID, {
      messages: [{ role: "candidate", content: "I want practice" }],
    });
    expect(mocks.createInterviewFromAgentConfig).not.toHaveBeenCalled();
  });

  it("auto-creates the interview from a complete generated config", async () => {
    const session = { sessionId: "session-1" };
    mocks.createInterviewFromAgentConfig.mockResolvedValue(session);
    const config = {
      purpose: "practice",
      jobRole: "Engineer",
      jobDescription: "APIs",
      strictness: "rigorous",
      category: "technical",
    };
    const response = await POST(request({ action: "create", config, missingFields: [] }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ session });
    expect(mocks.createInterviewFromAgentConfig).toHaveBeenCalledWith(USER_ID, {
      config,
      missingFields: [],
    });
  });

  it("maps provider and config failures to safe error envelopes", async () => {
    mocks.runAgentTurn.mockRejectedValueOnce(
      new LlmError("generation_failed", "provider refused sk-secret at https://secret.host"),
    );
    const failed = await POST(request({ action: "turn", messages: [{ role: "candidate", content: "hi" }] }));
    expect(failed.status).toBe(502);
    const body = await failed.json();
    expect(body.error).toMatchObject({ code: "provider_failed" });
    expect(JSON.stringify(body)).not.toContain("sk-secret");
    expect(JSON.stringify(body)).not.toContain("secret.host");

    mocks.createInterviewFromAgentConfig.mockRejectedValueOnce(
      new AgentError("invalid_input", "Complete every interview detail before creating the session."),
    );
    const invalid = await POST(request({ action: "create", config: {}, missingFields: ["strictness"] }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("rejects an unknown action before touching the services", async () => {
    const response = await POST(request({ action: "teleport" }));
    expect(response.status).toBe(400);
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
    expect(mocks.createInterviewFromAgentConfig).not.toHaveBeenCalled();
  });
});
