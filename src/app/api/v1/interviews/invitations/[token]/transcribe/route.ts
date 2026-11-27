import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { AsrError, transcribeAudio } from "@/lib/ai/asr";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import { resolveForOutboundCall } from "@/lib/providers/config";
import { createDefaultRoomStore } from "@/lib/interview/room-store";

/**
 * POST /api/v1/interviews/invitations/[token]/transcribe — voice input for
 * ONE interview (TT-9; FR-INTERVIEW-004). The link is the only capability;
 * the returned text is placed in the candidate's input for review before it
 * is sent as a turn. No audio is persisted (transcript remains the record).
 */
const bodySchema = z
  .object({
    audioBase64: z.string().min(1).max(14_000_000), // ~10 MB of audio
    mimeType: z.enum(["audio/webm", "audio/wav", "audio/mp3", "audio/mpeg", "audio/ogg", "audio/mp4"]),
  })
  .strict();

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/transcribe">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const interview = await createDefaultRoomStore().context(token);
    if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await request.json());
    } catch {
      return jsonError(400, "invalid_input", "A valid audio recording is required.");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.audioBase64, "base64");
    } catch {
      return jsonError(400, "invalid_input", "The audio recording is malformed.");
    }
    if (bytes.length === 0) {
      return jsonError(400, "invalid_input", "The audio recording is empty.");
    }

    let resolved;
    try {
      resolved = await resolveForOutboundCall(interview.userId, "asr");
    } catch {
      return jsonError(
        409,
        "voice_not_configured",
        "Voice input needs an enabled speech-recognition provider. Type your answer instead.",
      );
    }
    const route: ProviderRoute = {
      providerName: resolved.providerName,
      providerType: resolved.providerType,
      baseUrl: resolved.baseUrl,
      modelId: resolved.modelId,
      apiKey: resolved.apiKey,
    };

    try {
      const text = await transcribeAudio(route, new Uint8Array(bytes), body.mimeType);
      return Response.json({ text });
    } catch (error) {
      if (error instanceof AsrError) {
        return jsonError(
          error.code === "empty_transcript" ? 422 : 502,
          error.code === "empty_transcript" ? "no_speech" : "provider_failed",
          error.code === "empty_transcript"
            ? error.message
            : "The configured speech provider could not transcribe this recording.",
        );
      }
      return jsonError(500, "internal_error", "Something went wrong. Try again.");
    }
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
