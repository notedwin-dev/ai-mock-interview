import path from "node:path";
import { createLocalVolumeStore } from "./local-volume";
import type { ObjectStore } from "./types";

/**
 * Object-store factory (docs/ARCHITECTURE.md §8). The local volume is the
 * approved MVP backend; an S3-compatible backend replaces it here without
 * touching call sites. Storage roots are resolved at first use so unit tests
 * never require the directory to exist.
 */

let store: ObjectStore | undefined;

export function getObjectStore(): ObjectStore {
  if (store) return store;
  const configured = process.env["STORAGE_LOCAL_ROOT"]?.trim() || "./storage";
  store = createLocalVolumeStore(path.resolve(configured));
  return store;
}

export type { ObjectStore } from "./types";
export { buildResumeStorageKey } from "./local-volume";
