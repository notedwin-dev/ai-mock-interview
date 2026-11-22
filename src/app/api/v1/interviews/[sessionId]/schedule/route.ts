import { errorResponse, jsonError } from "@/lib/api/respond";
import { requireApiAccount } from "@/lib/auth/guard";
import { clearSchedule, scheduleInterview } from "@/lib/interview/scheduling";

/**
 * POST/DELETE /api/v1/interviews/[sessionId]/schedule — candidate-owned
 * scheduling. The stored time is informational; joining still starts the
 * interview. Foreign sessions look like missing ones.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/[sessionId]/schedule">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");
  try {
    const { sessionId } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    return Response.json(await scheduleInterview(account.account.userId, sessionId, body));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/[sessionId]/schedule">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");
  try {
    const { sessionId } = await ctx.params;
    return Response.json(await clearSchedule(account.account.userId, sessionId));
  } catch (error) {
    return errorResponse(error);
  }
}
