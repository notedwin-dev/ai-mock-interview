/**
 * Recruiter-sharing consent state machine for uploaded resumes
 * (FR-PROFILE-005/006, candidate_resume_consent_chk / _revocation_chk).
 *
 * Invariants (mirrored by the DB CHECK constraints — the pure function keeps
 * them testable without a database):
 * - Shared ⇒ a consent timestamp and version exist (unchecked-by-default
 *   upload never shares).
 * - A revocation timestamp ⇒ the resume is currently not shared.
 * - Renewed sharing requires an explicit affirmative grant action.
 *
 * Each uploaded resume row is one version: re-uploading creates a new row
 * with its own unchecked consent decision; this machine only manages the
 * sharing state of a single row.
 */

export type ConsentAction =
  | { type: "grant"; consentVersion: string }
  | { type: "revoke" };

export interface ConsentState {
  isSharedWithRecruiters: boolean;
  sharingConsentedAt: Date | null;
  sharingConsentVersion: string | null;
  sharingRevokedAt: Date | null;
}

export type ConsentWrite = Partial<
  Pick<
    ConsentState,
    "isSharedWithRecruiters" | "sharingConsentedAt" | "sharingConsentVersion" | "sharingRevokedAt"
  >
>;

/**
 * Resolves the fields to write for a consent action on the current state.
 * The clock is injected so consent timestamps stay testable. A revoke on an
 * already-private resume is an idempotent no-op; a grant always (re)affirms
 * with a fresh timestamp and version.
 */
export function resolveConsentWrite(
  current: ConsentState,
  action: ConsentAction,
  now: Date,
): ConsentWrite {
  if (action.type === "grant") {
    return {
      isSharedWithRecruiters: true,
      sharingConsentedAt: now,
      sharingConsentVersion: action.consentVersion,
      sharingRevokedAt: null,
    };
  }

  if (!current.isSharedWithRecruiters) {
    return {};
  }
  return { isSharedWithRecruiters: false, sharingRevokedAt: now };
}
