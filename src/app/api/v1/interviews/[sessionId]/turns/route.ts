import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError, parseJsonBody } from "@/lib/api/respond";
import { submitTypedTurn } from "@/lib/interview/service";

/**
 * POST /api/v1/interviews/[sessionId]/turns — one typed candidate response
 * (FR-INTERVIEW-004). Retries with the same idempotency key return the
 * original message (NFR-REL-002) instead of duplicating it.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/[sessionId]/turns">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { sessionId } = await ctx.params;
    const body = await parseJsonBody(request);
    const { message, created } = await submitTypedTurn(account.account.userId, sessionId, body);
    return Response.json({ message, created }, { status: created ? 201 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
