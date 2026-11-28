import { beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewError } from "@/lib/interview/service";

const mocks = vi.hoisted(() => ({
  requireApiAccount: vi.fn(),
  scheduleInterview: vi.fn(),
  clearSchedule: vi.fn(),
}));
vi.mock("@/lib/auth/guard", () => ({ requireApiAccount: mocks.requireApiAccount }));
vi.mock("@/lib/interview/scheduling", () => ({
  scheduleInterview: mocks.scheduleInterview,
  clearSchedule: mocks.clearSchedule,
}));

import { DELETE, POST } from "./route";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const context = { params: Promise.resolve({ sessionId: SESSION_ID }) } as never;
function request(body: unknown) {
  return new Request("http://localhost/api/v1/interviews/session/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/v1/interviews/[sessionId]/schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAccount.mockResolvedValue({ account: { userId: USER_ID } });
  });

  it("requires the owning candidate for both methods", async () => {
    mocks.requireApiAccount.mockResolvedValue(null);
    expect((await POST(request({ scheduledAt: "2026-12-01T09:00:00.000Z" }), context)).status).toBe(401);
    expect((await DELETE(request({}), context)).status).toBe(401);
    expect(mocks.scheduleInterview).not.toHaveBeenCalled();
    expect(mocks.clearSchedule).not.toHaveBeenCalled();
  });

  it("saves a schedule for the owner and maps conflicts", async () => {
    mocks.scheduleInterview.mockResolvedValueOnce({
      sessionId: SESSION_ID,
      scheduledAt: "2026-12-01T09:00:00.000Z",
      status: "scheduled",
    });
    const ok = await POST(request({ scheduledAt: "2026-12-01T09:00:00.000Z" }), context);
    expect(ok.status).toBe(200);
    expect(mocks.scheduleInterview).toHaveBeenCalledWith(USER_ID, SESSION_ID, {
      scheduledAt: "2026-12-01T09:00:00.000Z",
    });

    mocks.scheduleInterview.mockRejectedValueOnce(
      new InterviewError("invalid_state", "This interview already started."),
    );
    const conflict = await POST(request({ scheduledAt: "2026-12-01T09:00:00.000Z" }), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "invalid_state" } });
  });

  it("reports foreign sessions as missing", async () => {
    mocks.clearSchedule.mockRejectedValueOnce(new InterviewError("not_found", "Missing."));
    const response = await DELETE(request({}), context);
    expect(response.status).toBe(404);
    expect(mocks.clearSchedule).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });
});
