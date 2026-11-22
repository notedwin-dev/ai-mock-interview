import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { deleteOwnResume, getOwnResumeForDownload } from "@/lib/profile/service";
import { safeContentDispositionFileName } from "@/lib/profile/resume-file";
import { getObjectStore } from "@/lib/storage";

/** GET /api/v1/profile/resumes/[resumeId] — owner download (any consent state). */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/v1/profile/resumes/[resumeId]">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { resumeId } = await ctx.params;
    const meta = await getOwnResumeForDownload(account.account.userId, resumeId);
    const bytes = await getObjectStore().getObject(meta.storageKey);
    if (!bytes) {
      return jsonError(404, "not_found", "The stored file is missing.");
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": meta.mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${safeContentDispositionFileName(meta.originalFileName)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/v1/profile/resumes/[resumeId] — removes the owned row, then
 * the stored file (idempotent). The row delete is the state change; the file
 * cleanup failure never resurrects the row.
 */
export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/v1/profile/resumes/[resumeId]">,
): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { resumeId } = await ctx.params;
    const { storageKey } = await deleteOwnResume(account.account.userId, resumeId);
    await getObjectStore().deleteObject(storageKey);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
