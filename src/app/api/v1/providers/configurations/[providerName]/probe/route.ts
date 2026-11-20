import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { findOwnedConfigRow } from "@/lib/providers/config";
import { probeProviderConfiguration } from "@/lib/providers/probe";

/**
 * POST /api/v1/providers/configurations/[providerName]/probe — verify every
 * configured capability against the real provider (FR-PROVIDER-006) without
 * sending any interview content. The probe result is always HTTP 200 with
 * per-capability statuses; it is not an error for a probe to report failures.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/providers/configurations/[providerName]/probe">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { providerName } = await ctx.params;
    const configId = new URL(request.url).searchParams.get("configId") ?? undefined;
    const result = await probeProviderConfiguration(account.account.userId, providerName, {
      // Ownership-scoped lookup; configId pins the right row when the same
      // provider serves several capabilities. Unknown/foreign ids fail closed.
      load: (userId, providerNameArg) => findOwnedConfigRow(userId, providerNameArg, configId),
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
