import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { findOwnedConfigRow } from "@/lib/providers/config";
import { discoverProviderModels } from "@/lib/providers/probe";

/**
 * GET /api/v1/providers/configurations/[providerName]/models — the provider's
 * model IDs (FR-PROVIDER-009), "when supported": a provider without a list
 * endpoint reports `models: null` (HTTP 200), while credential/quota/server
 * problems surface as the probe error taxonomy in `error`.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/v1/providers/configurations/[providerName]/models">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { providerName } = await ctx.params;
    const configId = new URL(request.url).searchParams.get("configId") ?? undefined;
    const result = await discoverProviderModels(account.account.userId, providerName, {
      load: (userId, providerNameArg) => findOwnedConfigRow(userId, providerNameArg, configId),
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
