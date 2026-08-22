import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // .claude/worktrees holds full checkouts of this repo; their tests are not ours to run.
    exclude: ["src/**/*.e2e.test.ts", "**/node_modules/**", "**/dist/**", "**/.claude/**"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/*.config.*", "**/.claude/**"],
    },
  },
});
