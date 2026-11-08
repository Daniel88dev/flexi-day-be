import { defineConfig } from "vitest/config";

/**
 * The Assistant eval (`pnpm run eval:assistant`), never part of `pnpm test` or
 * `test:e2e`. Real model calls: run it through the script, which creates the
 * run's database and hands over the key.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/evals/**/*.eval.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    fileParallelism: false,
    testTimeout: 4 * 60 * 60_000,
    hookTimeout: 60_000,
  },
});
