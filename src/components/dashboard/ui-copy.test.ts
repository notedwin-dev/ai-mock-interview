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
    // Drop JSX/block comments and line comments before scanning: IDs in an
    // explanatory comment are legitimate, IDs in copy or string literals are
    // not. Assert the ID pattern itself instead of requiring punctuation,
    // so a bare "ADR-0005" is caught just like "(ADR-0005)".
    const renderedSource = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(renderedSource).not.toMatch(/\b(?:ADR-\d{4}|FR-[A-Z0-9]+(?:-[A-Z0-9]+)*|TT-\d+)\b/);
  });
});
