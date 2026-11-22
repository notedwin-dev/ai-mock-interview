import { describe, expect, it } from "vitest";
import {
  assertResumeFile,
  ResumeFileError,
  RESUME_MAX_BYTES,
  safeContentDispositionFileName,
  sniffResumeKind,
} from "./resume-file";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK.."

const bytesOf = (...prefix: number[]) => new Uint8Array([...prefix, 1, 2, 3, 4, 5]);

describe("sniffResumeKind", () => {
  it("recognises PDF, legacy DOC and ZIP-packaged DOCX by magic bytes", () => {
    expect(sniffResumeKind(bytesOf(...PDF_MAGIC))).toBe("pdf");
    expect(sniffResumeKind(bytesOf(...OLE2_MAGIC))).toBe("doc");
    expect(sniffResumeKind(bytesOf(...ZIP_MAGIC))).toBe("docx");
    expect(sniffResumeKind(bytesOf(0x7f, 0x45, 0x4c, 0x46))).toBeNull(); // ELF binary
    expect(sniffResumeKind(bytesOf(0x3c, 0x68, 0x74, 0x6d, 0x6c))).toBeNull(); // "<html"
  });

  it("rejects files too short to carry a signature", () => {
    expect(sniffResumeKind(new Uint8Array([0x25, 0x50]))).toBeNull();
  });
});

describe("assertResumeFile", () => {
  it("accepts consistent declared types", () => {
    expect(
      assertResumeFile(bytesOf(...PDF_MAGIC), "application/pdf"),
    ).toBe("pdf");
    expect(
      assertResumeFile(
        bytesOf(...ZIP_MAGIC),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("docx");
    expect(assertResumeFile(bytesOf(...OLE2_MAGIC), "application/msword")).toBe("doc");
  });

  it("accepts generic/zip-family declared types only for ZIP-packaged files", () => {
    expect(assertResumeFile(bytesOf(...ZIP_MAGIC), "application/octet-stream")).toBe("docx");
    expect(assertResumeFile(bytesOf(...ZIP_MAGIC), "application/x-zip-compressed")).toBe("docx");
    expect(() => assertResumeFile(bytesOf(...OLE2_MAGIC), "application/zip")).toThrow();
  });

  it("rejects executables and other content regardless of the declared type", () => {
    expect(() => assertResumeFile(bytesOf(0x7f, 0x45, 0x4c, 0x46), "application/pdf")).toThrow(
      ResumeFileError,
    );
    expect(() => assertResumeFile(new Uint8Array(0), "application/pdf")).toThrow(ResumeFileError);
  });

  it("rejects a declared type outside the allowlist even with valid bytes", () => {
    expect(() => assertResumeFile(bytesOf(...PDF_MAGIC), "text/html")).toThrow(
      "declared file type",
    );
  });

  it("enforces the 5 MB cap before sniffing", () => {
    const big = new Uint8Array(RESUME_MAX_BYTES + 1);
    big.set(PDF_MAGIC, 0);
    try {
      assertResumeFile(big, "application/pdf");
      expect.unreachable("oversized file must be rejected");
    } catch (error) {
      expect((error as ResumeFileError).code).toBe("file_too_large");
    }
  });

  it("keeps ResumeFileError distinct with stable codes", () => {
    const error = new ResumeFileError("unsupported_file_type", "nope");
    expect(error.name).toBe("ResumeFileError");
    expect(error.code).toBe("unsupported_file_type");
  });
});

describe("safeContentDispositionFileName", () => {
  it("strips header-injection characters and quotes", () => {
    expect(safeContentDispositionFileName("cv\r\nX-Injected: 1.pdf")).toBe("cvX-Injected: 1.pdf");
    expect(safeContentDispositionFileName('my"resume"v2.pdf')).toBe("myresumev2.pdf");
    expect(safeContentDispositionFileName("back\\slash.pdf")).toBe("backslash.pdf");
  });

  it("replaces non-ASCII characters and never returns an empty name", () => {
    expect(safeContentDispositionFileName("résumé.pdf")).toBe("r_sum_.pdf");
    expect(safeContentDispositionFileName("   ")).toBe("resume");
  });
});
