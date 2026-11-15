import { z } from "zod";

/**
 * Resume upload validation (FR-PROFILE-005). Proposed policy values (owner
 * review pending): PDF/DOC/DOCX only, 5 MB cap. Declared MIME types from
 * browsers are advisory; the magic-byte sniff is authoritative so a renamed
 * executable cannot enter the store as a "resume".
 *
 * Files are stored privately and only served back through authenticated,
 * ownership-checked routes; nothing here executes or parses file content.
 */

export const RESUME_MAX_BYTES = 5 * 1024 * 1024;

export type ResumeKind = "pdf" | "doc" | "docx";

const CANONICAL_MIME: Record<ResumeKind, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Declared types tolerated for ZIP-packaged office files (browser variance). */
const ZIP_FAMILY_MIMES = new Set([
  "application/octet-stream",
  "application/x-zip-compressed",
  "application/zip",
]);

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

/** Magic-byte sniff: PDF (%PDF-), legacy DOC (OLE2 CDF), DOCX (ZIP/OOXML). */
export function sniffResumeKind(bytes: Uint8Array): ResumeKind | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // "%PDF-"
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "doc";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "docx"; // "PK.."
  return null;
}

function declaredKind(mimeType: string): ResumeKind | "zip-family" | null {
  const normalised = mimeType.trim().toLowerCase();
  if (normalised === CANONICAL_MIME.pdf) return "pdf";
  if (normalised === CANONICAL_MIME.doc) return "doc";
  if (normalised === CANONICAL_MIME.docx) return "docx";
  if (ZIP_FAMILY_MIMES.has(normalised)) return "zip-family";
  return null;
}

export class ResumeFileError extends Error {
  readonly code: "file_too_large" | "unsupported_file_type";

  constructor(code: "file_too_large" | "unsupported_file_type", message: string) {
    super(message);
    this.name = "ResumeFileError";
    this.code = code;
  }
}

/**
 * Accepts exactly one allowed kind whose bytes and declared type agree.
 * A declared generic/zip-family type is accepted only when the sniffed kind
 * is a ZIP-packaged office document; an unmapped declared type is rejected.
 */
export function assertResumeFile(bytes: Uint8Array, declaredMimeType: string): ResumeKind {
  if (bytes.byteLength === 0) {
    throw new ResumeFileError("unsupported_file_type", "The file is empty.");
  }
  if (bytes.byteLength > RESUME_MAX_BYTES) {
    throw new ResumeFileError(
      "file_too_large",
      "The resume exceeds the 5 MB limit.",
    );
  }

  const sniffed = sniffResumeKind(bytes);
  if (!sniffed) {
    throw new ResumeFileError(
      "unsupported_file_type",
      "Only PDF, DOC and DOCX resumes are accepted.",
    );
  }

  const declared = declaredKind(declaredMimeType);
  const compatible =
    declared === sniffed || (declared === "zip-family" && sniffed === "docx");
  if (!compatible) {
    throw new ResumeFileError(
      "unsupported_file_type",
      "The declared file type does not match the file content.",
    );
  }

  return sniffed;
}

/** Upload form contract: one "file" plus the optional unchecked consent. */
export const resumeUploadFormSchema = z
  .object({
    shareWithRecruiters: z
      .string()
      .optional()
      .transform((value) => value === "true"),
    consentVersion: z.string().trim().optional(),
  })
  .strict();

/**
 * Content-Disposition sanitisation: the stored filename is reflected in a
 * response header, so CR/LF/control characters and quotes are stripped and
 * the value is ASCII-bounded (RFC 6266 filename*= carries UTF-8 names).
 */
export function safeContentDispositionFileName(originalFileName: string): string {
  const stripped = originalFileName.replace(/[\r\n\u0000-\u001f\u007f"\\]/g, "").trim();
  const asciiSafe = stripped.replace(/[^\x20-\x7e]/g, "_").slice(0, 150);
  return asciiSafe.length > 0 ? asciiSafe : "resume";
}
