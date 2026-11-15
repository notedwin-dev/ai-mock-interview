/**
 * Storage interface (docs/ARCHITECTURE.md §8): resume files live under
 * private storage keys, served only through authenticated route handlers.
 * The interface is deliberately tiny so an S3-compatible backend can replace
 * the local volume without touching call sites.
 */

export interface ObjectStore {
  /** Stores bytes under a private key (overwrites nothing existing keys are per-upload unique). */
  putObject(key: string, bytes: Uint8Array): Promise<void>;
  /** Returns the stored bytes, or null when the key does not exist. */
  getObject(key: string): Promise<Uint8Array | null>;
  /** Removes the object; deleting a missing key is a no-op (idempotent). */
  deleteObject(key: string): Promise<void>;
}
