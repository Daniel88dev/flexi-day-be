import { config } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";

// Load .env.e2e.test for local e2e testing (if exists)
const envFile = resolve(process.cwd(), ".env.e2e.test");

if (existsSync(envFile)) {
  config({ path: envFile, override: true });
  console.log("E2E Test Environment Setup (from .env.e2e.test):");
} else {
  console.log("E2E Test Environment Setup (from environment):");
}

console.log("- DATABASE:", process.env.DATABASE);
console.log("- NODE_ENV:", process.env.NODE_ENV);
console.log("- PORT:", process.env.PORT);
