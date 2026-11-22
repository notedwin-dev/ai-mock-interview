import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { requireApiAccount } from "@/lib/auth/guard";
import { confirmGeneration, GenerationError } from "@/lib/interview/generation";

/** POST .../generation/[id]/confirm — apply the candidate's reviewed structured config. */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/generation/[id]/confirm">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");
  try {
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    return Response.json(await confirmGeneration(account.account.userId, id, body));
  } catch (error) {
    if (error instanceof GenerationError) {
      const status = error.code === "not_found" ? 404 : 409;
      return jsonError(status, error.code, error.message);
    }
    if (error instanceof z.ZodError) return jsonError(400, "invalid_input", "Invalid structured configuration.");
    return errorResponse(error);
  }
}
