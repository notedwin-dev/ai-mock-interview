import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError } from "@/lib/api/respond";
import { listOwnResumes, registerResumeUpload } from "@/lib/profile/service";
import { assertResumeFile, resumeUploadFormSchema } from "@/lib/profile/resume-file";
import { buildResumeStorageKey, getObjectStore } from "@/lib/storage";

/** GET /api/v1/profile/resumes — the caller's resume list, newest first. */
export async function GET(): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    return Response.json({ resumes: await listOwnResumes(account.account.userId) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/v1/profile/resumes — multipart upload of one resume file
 * (FR-PROFILE-005). Sharing consent is unchecked by default: it exists only
 * when the request explicitly carries shareWithRecruiters=true plus a
 * consent version. Storage write first, metadata row second; a failed
 * metadata write compensates by removing the stored object (no orphans).
 */
export async function POST(request: Request): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  const userId = account.account.userId;

  try {
    const form = await request.formData();
    // The file field itself is not part of the field schema (it is read
    // separately below); strict mode would otherwise reject the form.
    const fields = resumeUploadFormSchema.parse(
      Object.fromEntries([...form.entries()].filter(([key]) => key !== "file")),
    );
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return jsonError(400, "invalid_input", "Attach exactly one resume file.");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    assertResumeFile(bytes, file.type);

    const storageKey = buildResumeStorageKey(userId);
    const objectStore = getObjectStore();
    await objectStore.putObject(storageKey, bytes);

    try {
      const resume = await registerResumeUpload(userId, {
        originalFileName: file.name,
        mimeType: file.type,
        fileSizeBytes: bytes.byteLength,
        storageKey,
        shareWithRecruiters: fields.shareWithRecruiters,
        consentVersion: fields.consentVersion,
      });
      return Response.json({ resume }, { status: 201 });
    } catch (error) {
      // Compensating cleanup: never leave an untracked stored file behind.
      await objectStore.deleteObject(storageKey);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
