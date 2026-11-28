import { errorResponse, jsonError } from "@/lib/api/respond";
import { requireApiAccount } from "@/lib/auth/guard";
import { GenerationError, getGeneration } from "@/lib/interview/generation";

/** GET .../generation/[id] — status + latest spoken caption for the UI. */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/v1/interviews/generation/[id]">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");
  try {
    const { id } = await ctx.params;
    return Response.json(await getGeneration(account.account.userId, id));
  } catch (error) {
    if (error instanceof GenerationError && error.code === "not_found") {
      return jsonError(404, error.code, error.message);
    }
    return errorResponse(error);
  }
}
