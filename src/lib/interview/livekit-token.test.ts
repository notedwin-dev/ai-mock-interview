import { describe, expect, it, vi } from "vitest";
import { TrackSource } from "livekit-server-sdk";
import { mintParticipantToken } from "./livekit-token";

/** Hermetic tests for LiveKit participant credentials (WebRTC room). */
describe("mintParticipantToken", () => {
  it("grants mic-only room join to one interview room", async () => {
    const addGrant = vi.fn();
    const toJwt = vi.fn(async () => "signed-jwt");
    const input = {
      room: "session-1",
      identity: "candidate-session-1",
      displayName: "Candidate",
      url: "wss://project.livekit.cloud",
    };

    const result = await mintParticipantToken(
      input,
      { apiKey: "key", apiSecret: "secret" },
      {
        createToken: vi.fn(() => ({ addGrant, toJwt })) as never,
      },
    );

    expect(result).toEqual({ url: "wss://project.livekit.cloud", token: "signed-jwt" });
    expect(addGrant).toHaveBeenCalledWith({
      roomJoin: true,
      room: "session-1",
      canPublish: true,
      canSubscribe: true,
      canPublishSources: [TrackSource.MICROPHONE],
    });
  });

  it("does not expose the LiveKit secret in the result", async () => {
    const result = await mintParticipantToken(
      { room: "r", identity: "i", displayName: "C", url: "wss://x" },
      { apiKey: "key", apiSecret: "super-secret" },
      { createToken: vi.fn(() => ({ addGrant: vi.fn(), toJwt: async () => "jwt" })) as never },
    );
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });
});
