import { jsonError } from "@/lib/api/respond";
import { createRealtimeToken } from "@/lib/interview/realtime-token";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { resolveForOutboundCall } from "@/lib/providers/config";

/**
 * POST .../realtime/token — server-side setup for the token-scoped realtime
 * WebSocket room (Gemini Live / ElevenLabs Realtime; ADR-006 Option A). The
 * link is the only capability; the provider key stays here and only an
 * ephemeral client secret (session token / client secret) reaches the browser.
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

    const session = await createRealtimeToken({
      providerName: resolved.providerName,
      providerType: resolved.providerType,
      baseUrl: resolved.baseUrl,
      modelId: resolved.modelId,
      apiKey: resolved.apiKey,
    });
    return Response.json({
      token: session.token,
      url: session.url,
      modelId: resolved.modelId,
    });
  } catch {
    return jsonError(502, "realtime_setup_failed", "The realtime session could not be created.");
  }
}
