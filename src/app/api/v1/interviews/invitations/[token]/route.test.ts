import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveInvitation: vi.fn() }));
vi.mock("@/lib/interview/invitations", () => ({ resolveInvitation: mocks.resolveInvitation }));

import { GET } from "./route";

function context(token: string) {
  return { params: Promise.resolve({ token }) } as never;
}

describe("GET /api/v1/interviews/invitations/[token]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only the minimal confirmation view for a valid link", async () => {
    const view = {
      sessionId: "session-1",
      jobRole: "Backend Engineer",
      jobDescription: "APIs",
      categoryNameSnapshot: "General",
      evaluationMode: "balanced",
      runtimeMode: "custom",
      status: "scheduled",
    };
    mocks.resolveInvitation.mockResolvedValue(view);
    const response = await GET(new Request("http://localhost/api/v1/interviews/invitations/tok"), context("tok"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ interview: view });
    expect(Object.keys(view).sort()).toEqual([
      "categoryNameSnapshot", "evaluationMode", "jobDescription", "jobRole", "runtimeMode", "sessionId", "status",
    ]);
  });

  it("returns 404 for invalid or revoked links without revealing why", async () => {
    mocks.resolveInvitation.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/v1/interviews/invitations/bad"), context("bad"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("invitation_not_found");
    expect(JSON.stringify(body)).not.toContain("revoked");
    expect(JSON.stringify(body)).not.toContain("session-1");
  });
});
