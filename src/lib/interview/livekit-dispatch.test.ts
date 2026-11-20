import { describe, expect, it, vi } from "vitest";
import { dispatchInterviewerAgent } from "./livekit-dispatch";

/** Hermetic tests for explicit LiveKit agent dispatch (one per interview room). */
const dispatchClient = {
  listDispatch: vi.fn(async () => []),
  createDispatch: vi.fn(async () => ({ id: "dispatch-1" })),
};
const roomClient = { createRoom: vi.fn(async () => ({})) };

describe("dispatchInterviewerAgent", () => {
  it("dispatches once with the interview context in metadata", async () => {
    const result = await dispatchInterviewerAgent(
      { room: "session-1", inviteToken: "invite", jobRole: "Backend Engineer", jobDescription: "APIs" },
      { url: "wss://project.livekit.cloud", apiKey: "key", apiSecret: "secret" },
      { createClient: () => dispatchClient as never, createRoomClient: () => roomClient as never },
    );

    expect(roomClient.createRoom).toHaveBeenCalledWith({ name: "session-1" });
    expect(result).toBe(true);
    expect(dispatchClient.createDispatch).toHaveBeenCalledTimes(1);
    const [room, name, options] = dispatchClient.createDispatch.mock.calls[0] as unknown as [
      string, string, { metadata: string },
    ];
    expect(room).toBe("session-1");
    expect(name).toBe("aimis-interviewer");
    expect(JSON.parse(options.metadata)).toMatchObject({
      sessionId: "session-1", jobRole: "Backend Engineer", inviteToken: "invite",
    });
  });

  it("ignores LiveKit Cloud auto-dispatch and creates our named agent once", async () => {
    dispatchClient.listDispatch.mockResolvedValueOnce([{ id: "cloud-auto", agentName: "", metadata: "" }] as never);
    const result = await dispatchInterviewerAgent(
      { room: "session-1", inviteToken: "t", jobRole: "R", jobDescription: null },
      { url: "wss://x", apiKey: "k", apiSecret: "s" },
      { createClient: () => dispatchClient as never, createRoomClient: () => roomClient as never },
    );
    expect(result).toBe(true);
    expect(dispatchClient.createDispatch).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate our own named dispatch", async () => {
    dispatchClient.listDispatch.mockResolvedValueOnce([{ id: "ours", agentName: "aimis-interviewer", metadata: "" }] as never);
    const result = await dispatchInterviewerAgent(
      { room: "session-1", inviteToken: "t", jobRole: "R", jobDescription: null },
      { url: "wss://x", apiKey: "k", apiSecret: "s" },
      { createClient: () => dispatchClient as never, createRoomClient: () => roomClient as never },
    );
    expect(result).toBe(false);
    expect(dispatchClient.createDispatch).not.toHaveBeenCalled();
  });
});
