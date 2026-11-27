import { jsonError } from "@/lib/api/respond";
import { resolveInvitation } from "@/lib/interview/invitations";
import { createDefaultRoomStore } from "@/lib/interview/room-store";

/**
 * POST .../activate — invitation-authorized transition of a scheduled
 * interview to active. Live voice needs this before it connects: the realtime
 * transcript route accepts finalized lines only for an active session, so a
 * socket opened on a scheduled link would silently lose every transcript line.
 *
 * The unguessable invitation token is the only capability; no account session
 * is required. The store's transition is idempotent (an already-active
 * interview is a no-op that never resets startedAt) and refuses completed
 * links. The transcript route keeps its own active-state check at commit time.
 */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/activate">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const interview = await resolveInvitation(token);
    if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }

    const result = await createDefaultRoomStore().activate(interview.sessionId);
    if (result === "rejected") {
      return jsonError(409, "invalid_state", "This interview is not accepting live turns.");
    }
    return Response.json({ status: "active" });
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
