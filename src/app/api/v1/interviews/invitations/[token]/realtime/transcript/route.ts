import { z } from "zod";
import { jsonError, parseJsonBody } from "@/lib/api/respond";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/utils/constants";

/**
 * POST .../realtime/transcript — persists finalized native-realtime turns to the
 * same chronological transcript as typed turns (FR-TRANSCRIPT-001/002/004):
 * the store derives each interviewer utterance's kind and assessment unit, so
 * an acknowledgement is never stored as a primary question.
 * Client-provided IDs make repeated deliveries idempotent.
 */
const bodySchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            speaker: z.enum(["candidate", "interviewer"]),
            content: z.string().trim().min(1).max(5000),
            clientId: z.string().trim().regex(IDEMPOTENCY_KEY_PATTERN),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/realtime/transcript">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const store = createDefaultRoomStore();
    const interview = await store.context(token);
    if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await parseJsonBody(request));
    } catch {
      return jsonError(400, "invalid_input", "A valid set of finalized messages is required.");
    }

    for (const message of body.messages) {
      await store.appendRealtimeMessage(interview.sessionId, {
        speaker: message.speaker,
        contentText: message.content,
        clientId: message.clientId,
      });
    }
    return Response.json({ saved: body.messages.length });
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
