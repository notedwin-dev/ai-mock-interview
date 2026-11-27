import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { InterviewError } from "@/lib/interview/service";

/**
 * POST .../realtime/transcript — persists finalized Gemini Live turns to the
 * same chronological transcript as typed turns (FR-TRANSCRIPT-001/002).
 * Client-provided IDs make repeated deliveries idempotent. Only a RUNNING
 * interview accepts live lines: the link is checked here for a fast 404, and
 * the store re-checks "active" under the session row lock at commit time so a
 * line that arrives after completion is never written.
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
    // Unlike a typed turn (whose first answer starts a scheduled interview),
    // realtime has no start path: only a RUNNING interview accepts live lines,
    // so a scheduled or finished link is refused here and at commit time.
    if (!interview || interview.status !== "active") {
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
  } catch (error) {
    // The store re-checks "active" at commit time (under the session row lock);
    // losing that race to completion is a conflict, not a server failure.
    if (error instanceof InterviewError && error.code === "invalid_state") {
      return jsonError(409, error.code, error.message);
    }
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
