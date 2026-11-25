import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError, parseJsonBody } from "@/lib/api/respond";
import { setProfileVisibility } from "@/lib/profile/service";

/**
 * PUT /api/v1/profile/visibility — explicit publish/hide action
 * (FR-PROFILE-002); new profiles are private by default.
 */
export async function PUT(request: Request): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const body = (await parseJsonBody(request)) as { visibility?: unknown };
    const profile = await setProfileVisibility(account.account.userId, body?.visibility);
    return Response.json({ profile });
  } catch (error) {
    return errorResponse(error);
  }
}
