import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvitationError } from "@/lib/interview/invitations";

const mocks = vi.hoisted(() => ({
  requireApiAccount: vi.fn(),
  issueInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));
vi.mock("@/lib/auth/guard", () => ({ requireApiAccount: mocks.requireApiAccount }));
vi.mock("@/lib/interview/invitations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/interview/invitations")>();
  return { ...actual, issueInvitation: mocks.issueInvitation, revokeInvitation: mocks.revokeInvitation };
});

import { POST } from "./route";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const context = { params: Promise.resolve({ sessionId: SESSION_ID }) } as never;
function request(body: unknown) {
  return new Request("http://localhost/api/v1/interviews/session/invitation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/interviews/[sessionId]/invitation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAccount.mockResolvedValue({ account: { userId: USER_ID } });
  });

  it("requires the owning candidate", async () => {
    mocks.requireApiAccount.mockResolvedValue(null);
    const response = await POST(request({ action: "revoke" }), context);
    expect(response.status).toBe(401);
    expect(mocks.revokeInvitation).not.toHaveBeenCalled();
  });

  it("reissues a link for the owner", async () => {
    const issued = { token: "t".repeat(43), path: `/i/${"t".repeat(43)}` };
    mocks.issueInvitation.mockResolvedValue(issued);
    const response = await POST(request({ action: "reissue" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitation: issued });
    expect(mocks.issueInvitation).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  it("revokes a link and reports foreign sessions as missing", async () => {
    const ok = await POST(request({ action: "revoke" }), context);
    expect(ok.status).toBe(200);
    expect(mocks.revokeInvitation).toHaveBeenCalledWith(USER_ID, SESSION_ID);

    mocks.revokeInvitation.mockRejectedValueOnce(new InvitationError("not_found", "Interview not found."));
    const missing = await POST(request({ action: "revoke" }), context);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects unknown actions", async () => {
    const response = await POST(request({ action: "delete-everything" }), context);
    expect(response.status).toBe(400);
    expect(mocks.revokeInvitation).not.toHaveBeenCalled();
    expect(mocks.issueInvitation).not.toHaveBeenCalled();
  });
});
