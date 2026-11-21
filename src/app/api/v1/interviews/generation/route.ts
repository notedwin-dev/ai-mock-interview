import { errorResponse, jsonError } from "@/lib/api/respond";
import { requireApiAccount } from "@/lib/auth/guard";
import { GenerationError, startGeneration } from "@/lib/interview/generation";

/** POST /api/v1/interviews/generation — start a voice-driven generation room. */
export async function POST(): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");
  try {
    return Response.json(await startGeneration(account.account.userId), { status: 201 });
  } catch (error) {
    if (error instanceof GenerationError && error.code === "not_configured") {
      return jsonError(409, error.code, error.message);
    }
    return errorResponse(error);
  }
}
