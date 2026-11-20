import { jsonError } from "@/lib/api/respond";
import { getLiveKitConfig, participantIdentity } from "@/lib/livekit/env";
import { mintParticipantToken } from "@/lib/interview/livekit-token";
import { createDefaultRoomStore } from "@/lib/interview/room-store";

/**
 * POST .../webrtc/token — a token-scoped LiveKit participant credential for
 * ONE interview room (ADR-005/006). Camera publishing is never granted; the
 * room identity is a hash of the invite token, not a user identifier.
 */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/webrtc/token">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const interview = await createDefaultRoomStore().context(token);
    if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }

    let config;
    try {
      config = getLiveKitConfig();
    } catch {
      return jsonError(409, "webrtc_not_configured", "LiveKit WebRTC is not configured on this server.");
    }

    const session = await mintParticipantToken(
      {
        room: interview.sessionId,
        identity: participantIdentity(token),
        displayName: "Candidate",
        url: config.url,
      },
      { apiKey: config.apiKey, apiSecret: config.apiSecret },
    );
    return Response.json(session);
  } catch {
    return jsonError(502, "webrtc_setup_failed", "The live room could not be created.");
  }
}
