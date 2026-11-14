import { afterEach, describe, expect, it } from "vitest";
import { getAuthEnv } from "./env";

// getAuthEnv re-parses on every call (no module-level cache), so plain
// process.env mutation is enough — no module registry resets required.
afterEach(() => {
  delete process.env.AUTH_SECRET;
});

describe("getAuthEnv", () => {
  it("fails fast when AUTH_SECRET is missing", () => {
    delete process.env.AUTH_SECRET;
    expect(() => getAuthEnv()).toThrow(/AUTH_SECRET/);
  });

  it("fails fast when AUTH_SECRET is too short", () => {
    process.env.AUTH_SECRET = "short-secret";
    expect(() => getAuthEnv()).toThrow(/AUTH_SECRET/);
  });

  it("returns the configured secret when valid", () => {
    process.env.AUTH_SECRET = "a".repeat(32);
    expect(getAuthEnv().AUTH_SECRET).toBe("a".repeat(32));
  });
});
