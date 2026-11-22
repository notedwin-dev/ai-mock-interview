import { describe, expect, it } from "vitest";
import { resolveConsentWrite, type ConsentState } from "./consent";

const NOW = new Date("2026-11-15T10:00:00.000Z");

const unshared: ConsentState = {
  isSharedWithRecruiters: false,
  sharingConsentedAt: null,
  sharingConsentVersion: null,
  sharingRevokedAt: null,
};

const shared: ConsentState = {
  isSharedWithRecruiters: true,
  sharingConsentedAt: new Date("2026-11-01T09:00:00.000Z"),
  sharingConsentVersion: "2026-11",
  sharingRevokedAt: null,
};

describe("resolveConsentWrite (FR-PROFILE-005/006)", () => {
  it("a fresh grant shares with a timestamp and version, clearing any revocation", () => {
    const write = resolveConsentWrite(unshared, { type: "grant", consentVersion: "2026-11" }, NOW);
    expect(write).toEqual({
      isSharedWithRecruiters: true,
      sharingConsentedAt: NOW,
      sharingConsentVersion: "2026-11",
      sharingRevokedAt: null,
    });
  });

  it("renewed sharing after a revocation requires an explicit grant and refreshes the record", () => {
    const revoked: ConsentState = { ...shared, isSharedWithRecruiters: false, sharingRevokedAt: NOW };
    const write = resolveConsentWrite(revoked, { type: "grant", consentVersion: "2027-01" }, NOW);
    expect(write.isSharedWithRecruiters).toBe(true);
    expect(write.sharingConsentedAt).toBe(NOW);
    expect(write.sharingConsentVersion).toBe("2027-01");
    expect(write.sharingRevokedAt).toBeNull();
  });

  it("revoking an actively shared resume unshares it and stamps the revocation", () => {
    const write = resolveConsentWrite(shared, { type: "revoke" }, NOW);
    expect(write).toEqual({
      isSharedWithRecruiters: false,
      sharingRevokedAt: NOW,
    });
  });

  it("revoking an already-private resume is an idempotent no-op", () => {
    expect(Object.keys(resolveConsentWrite(unshared, { type: "revoke" }, NOW))).toHaveLength(0);
  });

  it("the produced writes always satisfy the DB invariants (shared ⇒ timestamp+version; revoked ⇒ not shared)", () => {
    const cases: Array<{ current: ConsentState; grant: boolean }> = [
      { current: unshared, grant: true },
      { current: shared, grant: true },
      { current: unshared, grant: false },
      { current: shared, grant: false },
    ];
    for (const { current, grant } of cases) {
      const next: ConsentState = {
        ...current,
        ...resolveConsentWrite(current, grant ? { type: "grant", consentVersion: "v" } : { type: "revoke" }, NOW),
      };
      if (next.isSharedWithRecruiters) {
        expect(next.sharingConsentedAt).not.toBeNull();
        expect(next.sharingConsentVersion).not.toBeNull();
      }
      if (next.sharingRevokedAt !== null) {
        expect(next.isSharedWithRecruiters).toBe(false);
      }
    }
  });
});
