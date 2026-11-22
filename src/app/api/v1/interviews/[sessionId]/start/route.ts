import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { startInterviewSession } from "@/lib/interview/service";

/** POST /api/v1/interviews/[sessionId]/start — created → active (FR-INTERVIEW-001). */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/[sessionId]/start">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { sessionId } = await ctx.params;
    const session = await startInterviewSession(account.account.userId, sessionId);
    return Response.json({ session });
  } catch (error) {
    return errorResponse(error);
  }
}
