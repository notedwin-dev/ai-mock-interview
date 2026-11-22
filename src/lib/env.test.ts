import { afterEach, describe, expect, it, vi } from "vitest";

// env.ts parses and freezes process.env at import time, so each case must
// start from a clean module registry with its own environment values.
afterEach(() => {
  vi.resetModules();
  delete process.env.DATABASE_URL;
});

describe("serverEnv", () => {
  it("accepts a valid DATABASE_URL", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/aimis";
    const { serverEnv } = await import("./env");
    expect(serverEnv.DATABASE_URL).toBe(
      "postgresql://user:pass@localhost:5432/aimis",
    );
  });

  it("fails fast when DATABASE_URL is missing", async () => {
    await expect(import("./env")).rejects.toThrow();
  });

  it("fails fast when DATABASE_URL is not a URL", async () => {
    process.env.DATABASE_URL = "not-a-url";
    await expect(import("./env")).rejects.toThrow();
  });
});
