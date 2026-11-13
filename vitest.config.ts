import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit/integration tests only. The project deliberately has no E2E runner yet
// (see docs/TESTING.md); add one as its own decision when the interview room UI exists.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // Tests must not reach the network or a live database; keep them hermetic.
    // Integration tests that need PostgreSQL use a dedicated database URL and
    // are skipped when it is not provided.
    passWithNoTests: true,
  },
});
