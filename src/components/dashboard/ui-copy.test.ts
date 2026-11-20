import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Internal requirement/decision IDs belong in code comments and docs, never
 * in text rendered to a candidate. Regression guard for the "(ADR-0005)"
 * string that was previously shown under "API key".
 */
describe("user-facing configuration copy", () => {
  it("does not render internal ADR/FR/TT references", () => {
    const source = readFileSync("src/components/dashboard/ProviderConfigurator.tsx", "utf8");
    const jsxText = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    expect(jsxText).not.toContain("(ADR-");
    expect(jsxText).not.toMatch(/[>(]\s*(FR-|TT-)/);
    expect(jsxText).not.toContain("never shown again (ADR-0005)");
  });
});
