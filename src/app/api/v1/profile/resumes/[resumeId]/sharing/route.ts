import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError, parseJsonBody } from "@/lib/api/respond";
import { updateResumeSharing } from "@/lib/profile/service";

/**
 * PUT /api/v1/profile/resumes/[resumeId]/sharing — explicit consent change
 * (FR-PROFILE-006): grant carries a consent version, revoke is immediate;
 * renewed sharing always requires a fresh affirmative grant.
 */
export async function PUT(
  request: Request,
  ctx: RouteContext<"/api/v1/profile/resumes/[resumeId]/sharing">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { resumeId } = await ctx.params;
    const body = await parseJsonBody(request);
    const resume = await updateResumeSharing(account.account.userId, resumeId, body);
    return Response.json({ resume });
  } catch (error) {
    return errorResponse(error);
  }
}
