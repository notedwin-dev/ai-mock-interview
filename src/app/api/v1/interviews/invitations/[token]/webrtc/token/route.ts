import { jsonError } from "@/lib/api/respond";
import { getLiveKitConfig, participantIdentity } from "@/lib/livekit/env";
import { dispatchInterviewerAgent } from "@/lib/interview/livekit-dispatch";
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
    const store = createDefaultRoomStore();
    const interview = await store.context(token);
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
    // Activate only once a join can actually be delivered: a misconfiguration
    // or minting failure must leave a scheduled interview scheduled. This still
    // runs before dispatch and the response, so a successful join enables End
    // immediately (the room_finished webhook remains authoritative for finish).
    if (interview.status === "scheduled") {
      const activation = await store.activate(interview.sessionId);
      // A concurrent finish may have claimed the session while the credential
      // was minted. Do not dispatch an agent or hand out a token for a room
      // that is no longer joinable.
      if (activation === "rejected") {
        return jsonError(404, "invitation_not_found", "This interview link is not available.");
      }
    }
    // The agent dispatch is best-effort: a worker outage must not prevent the
    // candidate from joining their room.
    try {
      await dispatchInterviewerAgent(
        {
          room: interview.sessionId,
          inviteToken: token,
          jobRole: interview.jobRole,
          jobDescription: interview.jobDescription,
          evaluationMode: interview.evaluationMode,
          experienceLevel: interview.experienceLevel,
          techStack: interview.techStack,
          questionCount: interview.questionCount,
        },
        config,
      );
    } catch {
      // reported by the worker logs, not to the candidate
    }
    return Response.json(session);
  } catch {
    return jsonError(502, "webrtc_setup_failed", "The live room could not be created.");
  }
}
