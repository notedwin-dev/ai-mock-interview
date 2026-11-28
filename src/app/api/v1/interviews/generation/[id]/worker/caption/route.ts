import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { GenerationError, postCaption } from "@/lib/interview/generation";

/**
 * POST .../worker/caption — token-scoped caption write from the LiveKit
 * generator worker. The capability travels in a header, never in the browser.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/generation/[id]/worker/caption">,
): Promise<Response> {
  const workerToken = request.headers.get("x-aimis-worker-token");
  if (!workerToken) return jsonError(401, "unauthorized", "Missing worker credential.");
  const { id } = await ctx.params;
  try {
    await postCaption(id, workerToken, await request.json());
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof GenerationError) {
      const status = error.code === "not_found" ? 404 : error.code === "invalid_worker" ? 401 : 409;
      return jsonError(status, error.code, error.message);
    }
    if (error instanceof z.ZodError) return jsonError(400, "invalid_input", "Invalid caption payload.");
    return jsonError(500, "internal_error", "Could not store the caption.");
  }
}
