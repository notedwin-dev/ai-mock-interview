import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { setActiveCapability } from "@/lib/providers/config";

/**
 * PATCH /api/v1/providers/configurations/[providerName]/active — select which
 * of the user's saved configurations is ACTIVE for a capability (owner
 * decision, 2026-11-24). Body: { capability }. The server enables the chosen
 * row and deactivates every other enabled row of the same user that serves
 * that capability (one active configuration per capability per user), in one
 * transaction. Ownership is enforced by the user scope; the response is a
 * credential-free summary (write-only keys, ADR-0005).
 */
export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/v1/providers/configurations/[providerName]/active">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { providerName } = await ctx.params;
    const body = (await request.json().catch(() => null)) as { capability?: unknown } | null;
    const configuration = await setActiveCapability(
      account.account.userId,
      providerName,
      body?.capability,
    );
    return Response.json({ configuration });
  } catch (error) {
    return errorResponse(error);
  }
}
