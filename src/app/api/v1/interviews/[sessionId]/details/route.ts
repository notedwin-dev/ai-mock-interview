import { errorResponse, jsonError } from "@/lib/api/respond";
import { requireApiAccount } from "@/lib/auth/guard";
import { editInterviewDetails } from "@/lib/interview/scheduling";

/**
 * PATCH /api/v1/interviews/[sessionId]/details — amend generated interview
 * details while the session has not started or completed (owner decision
 * 2026-11-22). Ownership and lifecycle are enforced server-side.
 */
export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/[sessionId]/details">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");
  try {
    const { sessionId } = await ctx.params;
    return Response.json(
      await editInterviewDetails(account.account.userId, sessionId, await request.json()),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
