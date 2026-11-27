import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ endInvitationInterview: vi.fn() }));
vi.mock("@/lib/interview/invitations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/interview/invitations")>(
    "@/lib/interview/invitations",
  );
  return { ...actual, endInvitationInterview: mocks.endInvitationInterview };
});

import { POST } from "./route";

const TOKEN = "t".repeat(43);
const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;

describe("POST /api/v1/interviews/invitations/[token]/end", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ends the interview behind the link and reports the completion state", async () => {
    mocks.endInvitationInterview.mockResolvedValue({
      sessionId: "session-1",
      status: "completed",
      completedAt: "2026-11-21T10:00:00.000Z",
      alreadyEnded: false,
    });

    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: "session-1",
      status: "completed",
      completedAt: "2026-11-21T10:00:00.000Z",
      alreadyEnded: false,
    });
    expect(mocks.endInvitationInterview).toHaveBeenCalledWith(TOKEN);
  });

  it("is idempotent for a repeated end request", async () => {
    mocks.endInvitationInterview.mockResolvedValue({
      sessionId: "session-1",
      status: "completed",
      completedAt: "2026-11-21T10:00:00.000Z",
      alreadyEnded: true,
    });

    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(200);
    expect((await response.json()).alreadyEnded).toBe(true);
  });

  it("hides why a link is unusable and rejects an interview that is not running", async () => {
    const { InvitationError } = await import("@/lib/interview/invitations");

    mocks.endInvitationInterview.mockRejectedValueOnce(
      new InvitationError("not_found", "This invitation link is not available."),
    );
    const missing = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("invitation_not_found");

    mocks.endInvitationInterview.mockRejectedValueOnce(
      new InvitationError("invalid_state", "This interview is not running."),
    );
    const invalid = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(invalid.status).toBe(409);
    expect((await invalid.json()).error.code).toBe("invalid_state");
  });
});
