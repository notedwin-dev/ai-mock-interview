import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObjectStore } from "./types";

/**
 * Local-volume ObjectStore backend (docs/ARCHITECTURE.md §8): files under a
 * dedicated private directory, addressed by storage keys that never contain
 * user-controlled content (route code builds keys from validated user IDs
 * and fresh UUIDs; the original filename lives in the database only).
 *
 * Key rules (fail closed): non-empty, no drive/absolute paths, no `..`
 * segments, no backslashes, no control characters, segments joined with "/".
 * The resolved file path is additionally verified to stay inside the volume
 * root (defence in depth against traversal on any platform).
 */

export function createLocalVolumeStore(rootDir: string): ObjectStore {
  const root = path.resolve(rootDir);

  function resolveKey(key: string): string {
    if (key.length === 0 || key.length > 500) {
      throw new Error("Invalid storage key.");
    }
    if (key !== key.trim() || /[\u0000-\u001f\u007f]/.test(key) || key.includes("\\")) {
      throw new Error("Invalid storage key.");
    }
    const segments = key.split("/");
    if (
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new Error("Invalid storage key.");
    }
    const resolved = path.resolve(root, ...segments);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("Invalid storage key.");
    }
    return resolved;
  }

  return {
    async putObject(key, bytes) {
      const filePath = resolveKey(key);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
    },

    async getObject(key) {
      const filePath = resolveKey(key);
      try {
        return new Uint8Array(await readFile(filePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async deleteObject(key) {
      const filePath = resolveKey(key);
      try {
        await unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return; // idempotent by contract
        }
        throw error;
      }
    },
  };
}

/** Per-upload private key: resumes/<ownerUserId>/<fresh uuid>. */
export function buildResumeStorageKey(ownerUserId: string): string {
  return `resumes/${ownerUserId}/${randomUUID()}`;
}
