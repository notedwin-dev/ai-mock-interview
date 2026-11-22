import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit/integration tests only. The project deliberately has no E2E runner yet
// (see docs/TESTING.md); add one as its own decision when the interview room UI exists.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    // .env supplies DATABASE_URL (parsed eagerly by src/lib/env.ts at import
    // time) and TEST_DATABASE_URL (integration gating, docs/TESTING.md). In CI
    // or any environment without .env, integration tests skip and unit tests
    // stay hermetic.
    setupFiles: ["dotenv/config", "./vitest.setup.mts"],
    // DB-backed suites truncate shared tables in the same database; parallel
    // workers deadlock (40P01) on the ACCESS EXCLUSIVE locks. Files run
    // sequentially instead.
    fileParallelism: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // Tests must not reach the network or a live database; keep them hermetic.
    // Integration tests that need PostgreSQL use a dedicated database URL and
    // are skipped when it is not provided.
    passWithNoTests: true,
  },
});
