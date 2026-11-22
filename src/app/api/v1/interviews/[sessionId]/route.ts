import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { getOwnInterviewTranscript } from "@/lib/interview/service";

/** GET /api/v1/interviews/[sessionId] — the owner's session + transcript. */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/[sessionId]">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { sessionId } = await ctx.params;
    return Response.json(await getOwnInterviewTranscript(account.account.userId, sessionId));
  } catch (error) {
    return errorResponse(error);
  }
}
