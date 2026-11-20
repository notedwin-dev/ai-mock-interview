import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { createDefaultRoomStore } from "@/lib/interview/room-store";

/**
 * POST .../realtime/transcript — persists finalized Gemini Live turns to the
 * same chronological transcript as typed turns (FR-TRANSCRIPT-001/002).
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
            clientId: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,100}$/),
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
      body = bodySchema.parse(await request.json());
    } catch {
      return jsonError(400, "invalid_input", "A valid set of finalized messages is required.");
    }

    for (const message of body.messages) {
      await store.appendRealtimeMessage(
        interview.sessionId,
        message.speaker,
        message.content,
        message.clientId,
      );
    }
    return Response.json({ saved: body.messages.length });
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
