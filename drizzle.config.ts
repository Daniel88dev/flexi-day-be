import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  schema: ["src/db/schema/auth-schema.ts"],
  out: "src/db/schema/out",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE ??
      process.env.DATABASE_URL ??
      (() => {
        throw new Error("DATABASE (or DATABASE_URL) is required");
      })(),
  },
});
