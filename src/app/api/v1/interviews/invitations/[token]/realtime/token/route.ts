import { jsonError } from "@/lib/api/respond";
import { RealtimeError, createRealtimeToken } from "@/lib/interview/realtime-token";
import { buildLiveInterviewInstructions } from "@/lib/interview/room";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { resolveForOutboundCall } from "@/lib/providers/config";

/**
 * POST .../realtime/token — server-side setup for the Gemini Live WebSocket
 * room (ADR-006 Option A). The link is the only capability; the provider key
 * stays here and only an ephemeral client secret reaches the browser.
 *
 * The AI SDK client POSTs its own `{ sessionConfig }`, but the server IGNORES
 * the request body and builds the session config itself from the interview
 * context (instructions = role/JD/question budget, FR-INTERVIEW-003), which it
 * then bakes into the client secret (Google requires the full session config
 * at token creation). This keeps the interview instructions server-owned and
 * means a malformed or missing body can never change what the live model is
 * told.
 */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/realtime/token">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const interview = await createDefaultRoomStore().context(token);
    if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }

    let resolved;
    try {
      resolved = await resolveForOutboundCall(interview.userId, "realtime");
    } catch {
      return jsonError(
        409,
        "realtime_not_configured",
        "No enabled realtime agent is configured for this interview.",
      );
    }

    // The server owns the interview instructions (single source of truth,
    // FR-INTERVIEW-003); the client's request body is not read.
    const instructions = buildLiveInterviewInstructions(interview);

    try {
      const session = await createRealtimeToken(resolved, {
        instructions,
        sessionConfig: {
          instructions,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          outputModalities: ["audio"],
        },
      });
      return Response.json({
        token: session.token,
        url: session.url,
        modelId: resolved.modelId,
      });
    } catch (error) {
      if (error instanceof RealtimeError && error.code === "unsupported_provider") {
        return jsonError(502, "realtime_provider_unsupported", error.message);
      }
      return jsonError(502, "realtime_setup_failed", "The realtime session could not be created.");
    }
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
