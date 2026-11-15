import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    env: { NODE_ENV: "test" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each test file gets its own process, so each gets its own in-memory database.
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // The real package throws outside a React Server Component build.
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
});
