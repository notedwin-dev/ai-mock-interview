import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { listActiveInterviewCategories } from "@/lib/interview/service";

/** GET /api/v1/interviews/categories — active categories for the setup screen. */
export async function GET(): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    return Response.json({ categories: await listActiveInterviewCategories() });
  } catch (error) {
    return errorResponse(error);
  }
}
