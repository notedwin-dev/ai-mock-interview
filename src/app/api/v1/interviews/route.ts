import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError, parseJsonBody } from "@/lib/api/respond";
import { createInterviewSession } from "@/lib/interview/service";

/**
 * POST /api/v1/interviews — create a session from the candidate's setup
 * (FR-SETUP-001..005, FR-INTERVIEW-001). The provider route is resolved and
 * snapshotted here; the interviewer runtime itself starts in M2.
 */
export async function POST(request: Request): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const parsed: unknown = await parseJsonBody(request);
    // Validate the shape before destructuring: null (and arrays/scalars) are
    // valid JSON but must be rejected as invalid input, not crash as a 500.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return jsonError(400, "invalid_input", "The request body is invalid.");
    }
    const body = parsed as Record<string, unknown>;
    // The creation key rides alongside the setup input; the strict setup
    // schema must not see it, but session creation uses it for replay safety.
    const { idempotencyKey, ...setup } = body;
    const session = await createInterviewSession(
      account.account.userId,
      setup,
      typeof idempotencyKey === "string" ? idempotencyKey : undefined,
    );
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
