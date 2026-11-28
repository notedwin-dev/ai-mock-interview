import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-scanning contract for request-time rendering (2026-11-19).
 *
 * What it guards: every segment that reads a session or invitation token
 * carries `export const instant = false`, so the segment is allowed to block
 * on the server while auth/token lookups resolve (the documented Cache
 * Components auth migration pattern). This test deliberately asserts the
 * source export rather than runtime navigation behaviour: the docs' e2e
 * alternative (the `instant()` helper) lives in `@next/playwright`, which the
 * dependency policy (CONVENTIONS.md) forbids adding without an owner
 * decision, so the source boundary is the cheapest guard available.
 *
 * Scope: the list is every page (plus the dashboard layout) in the app that
 * reads session or invitation-token data; other pages (sign-in, sign-up,
 * root) are static and must not appear here. Keep the list in sync when a
 * new request-scoped page is added.
 */
const REQUEST_TIME_PAGES = [
  "src/app/dashboard/layout.tsx",
  "src/app/dashboard/page.tsx",
  "src/app/dashboard/configuration/page.tsx",
  "src/app/dashboard/profile/page.tsx",
  "src/app/dashboard/interview/new/page.tsx",
  "src/app/dashboard/interview/[sessionId]/page.tsx",
  "src/app/dashboard/interview/agent/page.tsx",
  "src/app/interview/[token]/page.tsx",
  "src/app/interview/[token]/waiting/page.tsx",
  "src/app/interview/[token]/room/page.tsx",
];

describe("request-time rendering contract", () => {
  it("opts every auth/token-scoped page out of instant-navigation validation", () => {
    for (const path of REQUEST_TIME_PAGES) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toMatch(/export const instant = false;/);
    }
  });
});
