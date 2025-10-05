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
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["./src/tests/e2e/setup.ts"],
  },
});
