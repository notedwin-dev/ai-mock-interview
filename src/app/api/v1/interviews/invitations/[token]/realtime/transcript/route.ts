import { z } from "zod";
import { jsonError, parseJsonBody } from "@/lib/api/respond";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { InterviewError } from "@/lib/interview/service";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/utils/constants";

/**
 * POST .../realtime/transcript — persists finalized native-realtime turns to the
 * same chronological transcript as typed turns (FR-TRANSCRIPT-001/002/004):
 * the store derives each interviewer utterance's kind and assessment unit, so
 * an acknowledgement is never stored as a primary question. Client-provided IDs
 * make repeated deliveries idempotent (same speaker and content); a reused ID
 * carrying different content is a visible conflict. Only a RUNNING interview
 * accepts live lines: the link is checked here for a fast 404, and the store
 * re-checks "active" under the session row lock at commit time so a line that
 * arrives after completion is never written.
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
    // Unlike a typed turn (whose first answer starts a scheduled interview),
    // realtime has no start path: only a RUNNING interview accepts live lines,
    // so a scheduled or finished link is refused here and at commit time.
    if (!interview || interview.status !== "active") {
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
  } catch (error) {
    // The store re-checks "active" at commit time (under the session row lock);
    // losing that race to completion is a conflict, not a server failure.
    if (
      error instanceof InterviewError &&
      (error.code === "invalid_state" || error.code === "client_id_conflict")
    ) {
      return jsonError(409, error.code, error.message);
    }
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
