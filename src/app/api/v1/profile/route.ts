import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { getOwnProfile, saveOwnProfile } from "@/lib/profile/service";

/** GET /api/v1/profile — the caller's own profile (null before first save). */
export async function GET(): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    return Response.json({ profile: await getOwnProfile(account.account.userId) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** PUT /api/v1/profile — create-or-update the caller's profile (FR-PROFILE-001). */
export async function PUT(request: Request): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const body = await request.json();
    const profile = await saveOwnProfile(account.account.userId, body);
    return Response.json({ profile });
  } catch (error) {
    return errorResponse(error);
  }
}
