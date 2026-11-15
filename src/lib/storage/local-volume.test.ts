import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalVolumeStore } from "./local-volume";

/**
 * Unit tests for the local-volume ObjectStore (docs/ARCHITECTURE.md §8) —
 * byte round-trips, idempotent deletes and fail-closed key validation.
 */

const bytes = (text: string) => new TextEncoder().encode(text);

describe("createLocalVolumeStore", () => {
  let root: string;
  let store: ReturnType<typeof createLocalVolumeStore>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aimis-storage-"));
    store = createLocalVolumeStore(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes through nested keys", async () => {
    await store.putObject("resumes/owner-1/abc", bytes("hello resume"));
    const data = await store.getObject("resumes/owner-1/abc");
    expect(new TextDecoder().decode(data!)).toBe("hello resume");
  });

  it("getObject returns null for a missing key", async () => {
    expect(await store.getObject("resumes/none/none")).toBeNull();
  });

  it("deleteObject removes an existing key and is idempotent for missing ones", async () => {
    await store.putObject("resumes/owner-2/xyz", bytes("doomed"));
    await store.deleteObject("resumes/owner-2/xyz");
    expect(await store.getObject("resumes/owner-2/xyz")).toBeNull();
    await expect(store.deleteObject("resumes/owner-2/xyz")).resolves.toBeUndefined();
  });

  it("overwriting an existing key replaces the bytes", async () => {
    await store.putObject("resumes/owner-3/dup", bytes("v1"));
    await store.putObject("resumes/owner-3/dup", bytes("v2"));
    expect(new TextDecoder().decode((await store.getObject("resumes/owner-3/dup"))!)).toBe("v2");
  });

  it.each([
    ["", "empty key"],
    ["resumes/../escape", "parent traversal"],
    ["../escape", "leading parent traversal"],
    ["/etc/passwd", "absolute path"],
    ["C:\\resumes\\x", "drive path with backslashes"],
    ["resumes/owner\\key", "backslash separator"],
    ["resumes//owner", "empty segment"],
    ["resumes/./owner", "dot segment"],
    ["resumes/owner/\u0000", "control character"],
    [" resumes/owner", "untrimmed key"],
  ])("rejects an invalid key: %s (%s)", async (key) => {
    await expect(store.putObject(key, bytes("x"))).rejects.toThrow("Invalid storage key");
    await expect(store.getObject(key)).rejects.toThrow("Invalid storage key");
    await expect(store.deleteObject(key)).rejects.toThrow("Invalid storage key");
  });

  it("keys longer than 500 characters are rejected", async () => {
    const longKey = `resumes/${"a".repeat(600)}`;
    await expect(store.putObject(longKey, bytes("x"))).rejects.toThrow("Invalid storage key");
  });
});
