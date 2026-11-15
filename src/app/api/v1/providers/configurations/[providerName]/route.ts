import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import {
  deleteProviderConfiguration,
  updateProviderConfiguration,
} from "@/lib/providers/config";

/**
 * PATCH /api/v1/providers/configurations/[providerName] — update base URL,
 * key, capabilities or enabled flag (FR-PROVIDER-001..003). Material changes
 * reset the stored credential status to unvalidated so a stale "valid" never
 * survives an edit.
 */
export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/v1/providers/configurations/[providerName]">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { providerName } = await ctx.params;
    const body = await request.json();
    const configuration = await updateProviderConfiguration(account.account.userId, providerName, body);
    return Response.json({ configuration });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/v1/providers/configurations/[providerName] — remove one row. */
export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/v1/providers/configurations/[providerName]">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { providerName } = await ctx.params;
    await deleteProviderConfiguration(account.account.userId, providerName);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
