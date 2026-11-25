import { jsonError } from "@/lib/api/respond";
import { isLiveTranscribeModel } from "@/lib/ai/live-transcribe";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { resolveForOutboundCall } from "@/lib/providers/config";

/**
 * GET .../asr/config — tells the candidate room which ASR mode to use.
 * Returns no credential and no base URL: only the mode and a label.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/asr/config">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const interview = await createDefaultRoomStore().context(token);
    if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }
    let resolved;
    try {
      resolved = await resolveForOutboundCall(interview.userId, "asr");
    } catch {
      return jsonError(409, "voice_not_configured", "No speech-recognition provider is enabled.");
    }
    return Response.json({
      mode: isLiveTranscribeModel(resolved.modelId) ? "stream" : "batch",
      providerName: resolved.providerName,
    });
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
