/**
 * Vitest setup: align the application's database module with the integration
 * database. Services under test import `@/lib/db`, which reads DATABASE_URL,
 * while db-backed suites gate on TEST_DATABASE_URL (docs/TESTING.md: the
 * integration database is dedicated and never the dev database).
 *
 * When the integration gate is set, DATABASE_URL is pointed at the same
 * database inside the test process only, before any module is imported —
 * src/lib/env.ts parses the environment eagerly at import time.
 *
 * Without TEST_DATABASE_URL nothing is overridden: integration tests skip and
 * unit tests stay hermetic (the default `pnpm test` / `pnpm verify` path).
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
