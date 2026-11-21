import { jsonError } from "@/lib/api/respond";
import { endInvitationInterview, InvitationError } from "@/lib/interview/invitations";

/**
 * POST /api/v1/interviews/invitations/[token]/end — the candidate ends the
 * active interview from their invitation link (FR-INTERVIEW-011). The link is
 * the only capability; no account session is required. Repeat requests are
 * idempotent and return the same completion state.
 */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/end">,
): Promise<Response> {
  const { token } = await ctx.params;
  try {
    return Response.json(await endInvitationInterview(token));
  } catch (error) {
    if (error instanceof InvitationError) {
      if (error.code === "not_found") {
        return jsonError(404, "invitation_not_found", "This interview link is not available.");
      }
      return jsonError(409, "invalid_state", error.message);
    }
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
