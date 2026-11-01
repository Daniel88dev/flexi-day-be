import { config } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import pg from "pg";

const envFile = resolve(process.cwd(), ".env.e2e.test");
if (existsSync(envFile)) {
  config({ path: envFile, override: true });
}

const databaseUrl = process.env.DATABASE || "";

if (!databaseUrl.includes("testdb")) {
  console.error("\n❌ ERROR: Not using test database!");
  console.error("Expected DATABASE to contain 'testdb'");
  console.error("Current DATABASE:", databaseUrl);
  console.error("\n💡 Make sure Docker database is running:");
  console.error("   docker compose -f docker-compose.e2e.yml up -d postgres\n");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  console.log("✅ Successfully connected to test database");
  await client.end();
} catch (error) {
  console.error("\n❌ ERROR: Cannot connect to test database!");
  console.error("Database URL:", databaseUrl);
  console.error("\n💡 Make sure Docker database is running:");
  console.error("   docker compose -f docker-compose.e2e.yml up -d postgres\n");
  if (error instanceof Error) {
    console.error("Error:", error.message);
  }
  process.exit(1);
}
