import { defineConfig } from "vitest/config";
import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";

// Load .env.e2e.test before anything else
const envFile = resolve(process.cwd(), ".env.e2e.test");
if (existsSync(envFile)) {
  loadDotenv({ path: envFile, override: true });
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.e2e.test.ts"],
    // .claude/worktrees holds full checkouts of this repo; their tests are not ours to run.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    // Every e2e file talks to the same database and truncates shared tables on
    // teardown, so running two files at once lets one wipe the other's rows.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["./src/tests/e2e/setup.ts"],
  },
});
