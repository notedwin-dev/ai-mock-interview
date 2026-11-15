import { describe, expect, it } from "vitest";
import { profileInputSchema, profileVisibilitySchema, consentVersionSchema } from "./validation";
import { toPublicProjection, type ProfileSummary } from "./projection";

describe("profileInputSchema (FR-PROFILE-001/004)", () => {
  const base = {
    displayName: "Jane Doe",
    headline: "Backend engineer",
    professionalSummary: "Five years of API work.",
    targetRole: "Senior Backend Engineer",
    skills: ["TypeScript", "PostgreSQL"],
    education: [{ institution: "XYZ University", qualification: "BSc CS", period: "2020-2024" }],
    experience: [{ organisation: "ACME", role: "Backend dev", period: "2024-", summary: "APIs." }],
    portfolioLinks: ["https://jane.example.com"],
  };

  it("applies unchecked-defaults for the JSONB arrays (empty, not required)", () => {
    const parsed = profileInputSchema.parse({ displayName: "Jane" });
    expect(parsed.skills).toEqual([]);
    expect(parsed.education).toEqual([]);
    expect(parsed.experience).toEqual([]);
    expect(parsed.portfolioLinks).toEqual([]);
  });

  it("rejects a display name beyond the VARCHAR(100) column limit", () => {
    expect(() => profileInputSchema.parse({ displayName: "d".repeat(101) })).toThrow();
  });

  it("rejects a headline beyond VARCHAR(160) and a target role beyond VARCHAR(150)", () => {
    expect(() => profileInputSchema.parse({ displayName: "J", headline: "h".repeat(161) })).toThrow();
    expect(() => profileInputSchema.parse({ displayName: "J", targetRole: "t".repeat(151) })).toThrow();
  });

  it("rejects malformed portfolio links and array overflow", () => {
    expect(() => profileInputSchema.parse({ displayName: "J", portfolioLinks: ["not-a-url"] })).toThrow();
    expect(() =>
      profileInputSchema.parse({ displayName: "J", skills: Array.from({ length: 31 }, () => "s") }),
    ).toThrow();
  });

  it("rejects unknown fields (strict contract)", () => {
    expect(() => profileInputSchema.parse({ displayName: "J", isAdmin: true })).toThrow();
  });

  it("accepts the full approved shape", () => {
    expect(() => profileInputSchema.parse(base)).not.toThrow();
  });
});

describe("profileVisibilitySchema (FR-PROFILE-002)", () => {
  it("matches the DB CHECK domain exactly", () => {
    expect(profileVisibilitySchema.options).toEqual(["private", "public"]);
    expect(() => profileVisibilitySchema.parse("unlisted")).toThrow();
  });
});

describe("consentVersionSchema", () => {
  it("accepts practical version labels and rejects whitespace/control characters", () => {
    expect(() => consentVersionSchema.parse("2026-11")).not.toThrow();
    expect(() => consentVersionSchema.parse("v1.2")).not.toThrow();
    expect(() => consentVersionSchema.parse("has space")).toThrow();
    expect(() => consentVersionSchema.parse("v".repeat(51))).toThrow();
  });
});

describe("toPublicProjection (FR-PROFILE-003)", () => {
  const full: ProfileSummary = {
    displayName: "Jane Doe",
    headline: "Backend engineer",
    professionalSummary: "PRIVATE SUMMARY",
    targetRole: "PRIVATE TARGET",
    skills: ["TypeScript"],
    education: [{ institution: "XYZ University", qualification: "BSc CS" }],
    experience: [{ organisation: "ACME", role: "Backend dev" }],
    portfolioLinks: ["https://jane.example.com"],
    visibility: "public",
    updatedAt: "2026-11-15T00:00:00.000Z",
  };

  it("exposes only the approved allowlist fields", () => {
    const projection = toPublicProjection(full);
    expect(Object.keys(projection).sort()).toEqual([
      "displayName",
      "education",
      "experience",
      "headline",
      "portfolioLinks",
      "skills",
    ]);
  });

  it("never carries private fields into the recruiter-facing shape", () => {
    const serialised = JSON.stringify(toPublicProjection(full));
    expect(serialised).not.toContain("PRIVATE SUMMARY");
    expect(serialised).not.toContain("PRIVATE TARGET");
    expect(serialised).not.toContain("professionalSummary");
    expect(serialised).not.toContain("targetRole");
  });
});
