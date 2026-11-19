import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the infinite reload loop (2026-11-19): requireAccount()
 * calls connection(), which hangs during prerendering. A page that reads auth
 * without `export const instant = false` leaves its Suspense stream open, and
 * the browser keeps reloading the stalled document. Next does not expose the
 * segment config to a plain unit import (the page pulls Next server modules),
 * so the contract is asserted at the source boundary.
 */
const REQUEST_TIME_PAGES = [
  "src/app/dashboard/layout.tsx",
  "src/app/dashboard/page.tsx",
  "src/app/dashboard/configuration/page.tsx",
  "src/app/dashboard/profile/page.tsx",
  "src/app/dashboard/interview/new/page.tsx",
  "src/app/dashboard/interview/[sessionId]/page.tsx",
  "src/app/dashboard/interview/agent/page.tsx",
  "src/app/i/[token]/page.tsx",
  "src/app/i/[token]/waiting/page.tsx",
  "src/app/i/[token]/room/page.tsx",
];

describe("request-time rendering contract", () => {
  it("opts every auth/token-scoped page out of instant-navigation validation", () => {
    for (const path of REQUEST_TIME_PAGES) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toMatch(/export const instant = false;/);
    }
  });
});
