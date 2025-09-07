import { defineConfig } from "drizzle-kit";
// @ts-ignore
import { config } from "./src/config";

export default defineConfig({
  schema: ["src/db/schema/auth-schema.ts"],
  out: "src/db/schema/out",
  dialect: "postgresql",
  dbCredentials: {
    url: config.db.database,
  },
});
