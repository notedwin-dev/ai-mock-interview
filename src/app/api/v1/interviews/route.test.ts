import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiAccount: vi.fn(),
  createInterviewSession: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({ requireApiAccount: mocks.requireApiAccount }));
vi.mock("@/lib/interview/service", () => ({
  createInterviewSession: mocks.createInterviewSession,
}));

import { POST } from "./route";

const USER_ID = "33333333-3333-4333-8333-333333333333";
function request(body: unknown): Request {
  return new Request("http://localhost/api/v1/interviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/interviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAccount.mockResolvedValue({ account: { userId: USER_ID } });
    mocks.createInterviewSession.mockResolvedValue({ session: {} });
  });

  it.each([null, [], "a string", 42])(
    "rejects a non-object body (%j) with 400 before creating a session",
    async (body) => {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
      expect(mocks.createInterviewSession).not.toHaveBeenCalled();
    },
  );

  it("passes the setup without the creation key and the key as the third argument", async () => {
    const response = await POST(request({
      jobRole: "Engineer",
      categoryId: "33333333-3333-4333-8333-333333333334",
      evaluationMode: "balanced",
      runtimeMode: "preset_realtime",
      idempotencyKey: "launch-key",
    }));

    expect(response.status).toBe(201);
    expect(mocks.createInterviewSession).toHaveBeenCalledWith(
      USER_ID,
      expect.not.objectContaining({ idempotencyKey: expect.anything() }),
      "launch-key",
    );
  });
});
