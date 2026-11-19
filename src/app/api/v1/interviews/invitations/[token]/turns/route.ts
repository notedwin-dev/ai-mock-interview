import { jsonError } from "@/lib/api/respond";
import { LlmError } from "@/lib/ai/llm";
import { synthesizeSpeech, type TtsRoute } from "@/lib/ai/tts";
import { resolveForOutboundCall } from "@/lib/providers/config";
import { resolveInvitation } from "@/lib/interview/invitations";
import { RoomError, runRoomTurn } from "@/lib/interview/room";
import { createDefaultRoomStore } from "@/lib/interview/room-store";

/**
 * Token-scoped room transcript (FR-INTERVIEW-004/008): the link is the only
 * capability. GET reads this interview's chronological messages; POST runs one
 * candidate turn plus the interviewer response and returns the updated
 * transcript. No account session and no other interview data is involved.
 */
function mapError(error: unknown): Response {
  if (error instanceof RoomError) {
    const status =
      error.code === "invitation_not_found" ? 404 : error.code === "invalid_state" ? 409 : 400;
    return jsonError(status, error.code, error.message);
  }
  if (error instanceof LlmError) {
    return jsonError(
      502,
      error.code === "invalid_output" ? "provider_invalid_output" : "provider_failed",
      "The configured interviewer could not respond. Check the provider configuration.",
    );
  }
  return jsonError(500, "internal_error", "Something went wrong. Try again.");
}

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/turns">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const interview = await resolveInvitation(token);
    if (!interview) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }
    const messages = await createDefaultRoomStore().messages(interview.sessionId);
    return Response.json({ messages });
  } catch (error) {
    return mapError(error);
  }
}

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/turns">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_input", "A valid interview turn is required.");
    }
    return Response.json(
      await runRoomTurn(token, body, {
        // The room engine receives the speaker route only here, at the server
        // boundary. A missing TTS configuration simply means text-only turns.
        tts: {
          resolveRoute: async (userId: string): Promise<TtsRoute | null> => {
            try {
              const resolved = await resolveForOutboundCall(userId, "tts");
              return {
                providerName: resolved.providerName,
                providerType: resolved.providerType,
                baseUrl: resolved.baseUrl,
                modelId: resolved.modelId,
                apiKey: resolved.apiKey,
              };
            } catch {
              return null;
            }
          },
          synthesize: synthesizeSpeech,
        },
      }),
    );
  } catch (error) {
    return mapError(error);
  }
}
