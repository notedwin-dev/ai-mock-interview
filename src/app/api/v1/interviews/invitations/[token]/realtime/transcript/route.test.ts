import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
