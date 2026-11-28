import { jsonError } from "@/lib/api/respond";
import { RealtimeError, createRealtimeToken } from "@/lib/interview/realtime-token";
import { buildLiveInterviewInstructions } from "@/lib/interview/room";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { getActiveRuntimeMode, resolveForOutboundCall } from "@/lib/providers/config";

/**
 * POST .../realtime/token — server-side setup for the token-scoped realtime
 * WebSocket room (Gemini Live / ElevenLabs Realtime; ADR-006 Option A). The
 * link is the only capability; the provider key stays here and only an
 * ephemeral client secret (session token / client secret) reaches the browser.
 *
 * The AI SDK client POSTs its own `{ sessionConfig }`, but the server IGNORES
 * the request body and builds the session config itself from the interview
 * context (instructions = role/JD/question budget, FR-INTERVIEW-003), which it
 * then bakes into the Google client secret (Google requires the full session
 * config at token creation). This keeps the interview instructions
 * server-owned and means a malformed or missing body can never change what the
 * live model is told. ElevenLabs mints its short-lived secret from the stored
 * key natively; the browser opens the documented Realtime WebSocket with it.
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
      // A realtime session keeps its runtime even if the account later saves
      // a different mode. Only that explicit switch is a conflict: an account
      // still in realtime mode merely has a missing or unusable agent.
      let activeMode: Awaited<ReturnType<typeof getActiveRuntimeMode>> = null;
      try {
        activeMode = await getActiveRuntimeMode(interview.userId);
      } catch {
        // An unreadable mode is not evidence of a mode conflict.
      }
      if (interview.runtimeMode === "preset_realtime" && activeMode === "custom") {
        return jsonError(
          409,
          "runtime_mode_conflict",
          "This interview uses the realtime runtime. Switch the account back to realtime mode to continue it.",
        );
      }
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
      // Google requires the full session config at token creation, so the
      // server-owned instructions are baked into its client secret. The
      // ElevenLabs native mint has no session payload — the browser supplies
      // instructions over the Realtime WebSocket instead.
      const session =
        resolved.providerName === "google"
          ? await createRealtimeToken(resolved, {
              instructions,
              sessionConfig: {
                instructions,
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                outputModalities: ["audio"],
              },
            })
          : await createRealtimeToken(resolved);
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
