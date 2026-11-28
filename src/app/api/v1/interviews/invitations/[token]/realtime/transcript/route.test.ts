import { beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewError } from "@/lib/interview/service";

const mocks = vi.hoisted(() => ({ context: vi.fn(), append: vi.fn() }));
vi.mock("@/lib/interview/room-store", () => ({
  createDefaultRoomStore: () => ({ context: mocks.context, appendRealtimeMessage: mocks.append }),
}));

import { POST } from "./route";

const TOKEN = "t".repeat(43);
const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;
function body(messages: unknown[] = []) {
  return new Request("http://localhost/x", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

describe("POST .../realtime/transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ sessionId: "s1", userId: "owner-1", status: "active" });
    mocks.append.mockResolvedValue({ sequenceNumber: 1 });
  });

  it("persists finalized speaker-attributed realtime messages idempotently", async () => {
    const response = await POST(body([
      { speaker: "candidate", content: "my answer", clientId: "evt-1" },
      { speaker: "interviewer", content: "a question", clientId: "evt-2" },
    ]), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: 2 });
    expect(mocks.append).toHaveBeenCalledTimes(2);
    expect(mocks.append).toHaveBeenNthCalledWith(1, "s1", {
      speaker: "candidate", contentText: "my answer", clientId: "evt-1",
    });
    expect(mocks.append).toHaveBeenNthCalledWith(2, "s1", {
      speaker: "interviewer", contentText: "a question", clientId: "evt-2",
    });
  });

  it("rejects invalid links and malformed messages", async () => {
    mocks.context.mockResolvedValueOnce(null);
    const missing = await POST(body([]), ctx);
    expect(missing.status).toBe(404);
    expect(mocks.append).not.toHaveBeenCalled();

    const bad = await POST(body([{ speaker: "system", content: "x", clientId: "e" }]), ctx);
    expect(bad.status).toBe(400);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("rejects live lines for a scheduled interview instead of starting it", async () => {
    // Realtime has no start path (unlike a typed turn): only a RUNNING
    // interview accepts finalized live lines.
    mocks.context.mockResolvedValue({ sessionId: "s1", userId: "owner-1", status: "scheduled" });

    const response = await POST(body([{ speaker: "candidate", content: "early", clientId: "evt-early" }]), ctx);

    expect(response.status).toBe(404);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("maps a reused client id with different content to a visible conflict", async () => {
    mocks.append.mockRejectedValue(
      new InterviewError("client_id_conflict", "A different message was already saved with this id."),
    );

    const response = await POST(body([{ speaker: "candidate", content: "new", clientId: "evt-1" }]), ctx);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "client_id_conflict" } });
  });

  it("maps a commit-time completion race to a conflict instead of a server error", async () => {
    // The store re-checks "active" under the session row lock, so a line that
    // arrives after the interview completed loses the race and is rejected.
    mocks.append.mockRejectedValue(
      new InterviewError("invalid_state", "This interview is not accepting turns."),
    );

    const response = await POST(body([{ speaker: "candidate", content: "late", clientId: "evt-late" }]), ctx);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
  });
});
