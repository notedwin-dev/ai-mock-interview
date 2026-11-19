import { jsonError } from "@/lib/api/respond";
import { resolveInvitation } from "@/lib/interview/invitations";

/**
 * GET /api/v1/interviews/invitations/[token] — token-scoped entry
 * (FR-SETUP-008). No account session is required: the unguessable link is the
 * only capability, and the response contains only ONE interview's confirmation
 * details (never other interviews or personal data). Missing, malformed and
 * revoked links are indistinguishable to the caller.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]">,
): Promise<Response> {
  const { token } = await ctx.params;
  const interview = await resolveInvitation(token);
  if (!interview) {
    return jsonError(404, "invitation_not_found", "This invitation link is not available.");
  }
  return Response.json({ interview });
}
