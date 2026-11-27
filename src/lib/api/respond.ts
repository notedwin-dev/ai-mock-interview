import { ProfileError } from "@/lib/profile/service";
import { ResumeFileError } from "@/lib/profile/resume-file";
import { InterviewError } from "@/lib/interview/service";
import { ProviderConfigError } from "@/lib/providers/config";
import { LlmError } from "@/lib/ai/llm";
import { z } from "zod";

/**
 * Shared /api/v1 response helpers: typed errors become JSON with stable
 * status codes; unexpected failures collapse to a generic 500 that never
 * echoes internals (NFR-SEC-008).
 */

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Maps an LlmError to a 502 with a safe, fixed message (shared by the
 * agent-led and token-scoped interview routes). Provider error text is never
 * forwarded: it can contain request URLs, headers or credential fragments
 * (NFR-SEC-008).
 */
export function llmErrorProviderResponse(error: LlmError): Response {
  return jsonError(
    502,
    error.code === "invalid_output" ? "provider_invalid_output" : "provider_failed",
    "The configured provider could not complete this request. Check the configuration and try again.",
  );
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ResumeFileError) {
    return jsonError(
      error.code === "file_too_large" ? 413 : 415,
      error.code,
      error.message,
    );
  }
  if (error instanceof ProfileError) {
    const status =
      error.code === "invalid_input" ? 400 : error.code === "profile_required" ? 409 : 404;
    return jsonError(status, error.code, error.message);
  }
  if (error instanceof InterviewError) {
    const status =
      error.code === "invalid_input"
        ? 400
        : error.code === "not_found"
          ? 404
          : 409; // invalid_state / provider_route_missing are conflict-shaped
    return jsonError(status, error.code, error.message);
  }
  if (error instanceof ProviderConfigError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "config_exists" || error.code === "probe_failed"
          ? 409
          : 400; // missing_credential / invalid_base_url / capability_not_supported / unknown_preset / reserved_preset_name / invalid_input
    return jsonError(status, error.code, error.message);
  }
  if (error instanceof z.ZodError) {
    return jsonError(400, "invalid_input", "The request body is invalid.");
  }
  return jsonError(500, "internal_error", "Something went wrong. Try again later.");
}
