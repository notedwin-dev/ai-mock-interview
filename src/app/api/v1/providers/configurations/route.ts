import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import {
  createProviderConfiguration,
  listProviderConfigurations,
} from "@/lib/providers/config";

/**
 * GET /api/v1/providers/configurations — the caller's configurations
 * (credential-free summaries; write-only keys, ADR-0005).
 */
export async function GET(): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    return Response.json({
      configurations: await listProviderConfigurations(account.account.userId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/v1/providers/configurations — save one configuration per provider
 * name (FR-PROVIDER-001/002). The key is encrypted server-side; responses
 * never echo credentials.
 */
export async function POST(request: Request): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const body = await request.json();
    const configuration = await createProviderConfiguration(account.account.userId, body);
    return Response.json({ configuration }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
