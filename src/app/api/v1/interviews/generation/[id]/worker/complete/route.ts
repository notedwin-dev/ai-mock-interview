import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { completeGeneration, GenerationError } from "@/lib/interview/generation";

/** POST .../worker/complete — creates the interview from the spoken briefing. */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/generation/[id]/worker/complete">,
): Promise<Response> {
  const workerToken = request.headers.get("x-aimis-worker-token");
  if (!workerToken) return jsonError(401, "unauthorized", "Missing worker credential.");
  const { id } = await ctx.params;
  try {
    const body = await request.json().catch(() => ({}));
    const result = await completeGeneration(id, workerToken, body);
    return Response.json(result);
  } catch (error) {
    if (error instanceof GenerationError) {
      const status = error.code === "not_found" ? 404 : error.code === "invalid_worker" ? 401 : 409;
      return jsonError(status, error.code, error.message);
    }
    if (error instanceof z.ZodError) return jsonError(400, "invalid_input", "Invalid generated configuration.");
    return jsonError(500, "internal_error", "Could not create the interview.");
  }
}
