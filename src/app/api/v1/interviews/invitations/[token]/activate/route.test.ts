import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), activate: vi.fn() }));
vi.mock("@/lib/interview/invitations", () => ({ resolveInvitation: mocks.resolve }));
vi.mock("@/lib/interview/room-store", () => ({
  createDefaultRoomStore: () => ({ activate: mocks.activate }),
}));

import { POST } from "./route";

const TOKEN = "t".repeat(43);
const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;
const request = () => new Request("http://localhost/x", { method: "POST" });

describe("POST .../activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({ sessionId: "s1", status: "scheduled" });
    mocks.activate.mockResolvedValue("activated");
  });

  it("activates a scheduled interview through the invitation token", async () => {
    const response = await POST(request(), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "active" });
    expect(mocks.activate).toHaveBeenCalledWith("s1");
  });

  it("succeeds without a transition for an already-active interview", async () => {
    mocks.resolve.mockResolvedValue({ sessionId: "s1", status: "active" });
    mocks.activate.mockResolvedValue("already_active");

    const response = await POST(request(), ctx);
    expect(response.status).toBe(200);
  });

  it("refuses missing, revoked and completed invitations without activating", async () => {
    mocks.resolve.mockResolvedValueOnce(null);
    expect((await POST(request(), ctx)).status).toBe(404);

    mocks.resolve.mockResolvedValueOnce({ sessionId: "s1", status: "completed" });
    expect((await POST(request(), ctx)).status).toBe(404);

    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("maps a rejected transition to a visible conflict", async () => {
    mocks.activate.mockResolvedValue("rejected");

    const response = await POST(request(), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
  });
});
