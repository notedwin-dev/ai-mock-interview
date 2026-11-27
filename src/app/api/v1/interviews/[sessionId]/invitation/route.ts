import { z } from "zod";
import { errorResponse, jsonError, parseJsonBody } from "@/lib/api/respond";
import { requireApiAccount } from "@/lib/auth/guard";
import {
  InvitationError,
  issueInvitation,
  revokeInvitation,
} from "@/lib/interview/invitations";

/**
 * POST /api/v1/interviews/[sessionId]/invitation — owner-only link management
 * (FR-SETUP-008). "reissue" replaces the link; "revoke" invalidates it. Both
 * operations are ownership-checked by the invitation service.
 */
const bodySchema = z.object({ action: z.enum(["reissue", "revoke"]) }).strict();

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/[sessionId]/invitation">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await parseJsonBody(request));
  } catch {
    return jsonError(400, "invalid_input", "A valid invitation action is required.");
  }

  try {
    const { sessionId } = await ctx.params;
    if (body.action === "reissue") {
      return Response.json({
        invitation: await issueInvitation(account.account.userId, sessionId),
      });
    }
    await revokeInvitation(account.account.userId, sessionId);
    return Response.json({ revoked: true });
  } catch (error) {
    if (error instanceof InvitationError) {
      return jsonError(
        error.code === "not_found" ? 404 : 409,
        error.code,
        error.message,
      );
    }
    return errorResponse(error);
  }
}
