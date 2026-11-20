import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), mint: vi.fn(), dispatch: vi.fn(async () => true) }));
vi.mock("@/lib/interview/room-store", () => ({ createDefaultRoomStore: () => ({ context: mocks.context }) }));
vi.mock("@/lib/interview/livekit-token", () => ({ mintParticipantToken: mocks.mint }));
vi.mock("@/lib/interview/livekit-dispatch", () => ({ dispatchInterviewerAgent: mocks.dispatch }));
vi.mock("@/lib/livekit/env", () => ({
  getLiveKitConfig: vi.fn(() => ({ url: "wss://project.livekit.cloud", apiKey: "key", apiSecret: "secret" })),
  participantIdentity: vi.fn(() => "candidate-abc123"),
}));

import { POST } from "./route";

const TOKEN = "t".repeat(43);
const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;

describe("POST .../webrtc/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      sessionId: "session-1", userId: "owner-1", jobRole: "Backend Engineer", status: "scheduled",
    });
    mocks.mint.mockResolvedValue({ url: "wss://project.livekit.cloud", token: "jwt" });
  });

  it("mints a room-scoped token for a valid interview link", async () => {
    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "wss://project.livekit.cloud", token: "jwt" });
    expect(mocks.mint).toHaveBeenCalledWith(
      expect.objectContaining({ room: "session-1" }),
      expect.objectContaining({ apiKey: "key", apiSecret: "secret" }),
    );
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ room: "session-1", inviteToken: TOKEN }),
      expect.objectContaining({ apiKey: "key" }),
    );
  });

  it("refuses invalid links", async () => {
    mocks.context.mockResolvedValueOnce(null);
    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(404);
    expect(mocks.mint).not.toHaveBeenCalled();
  });
});
