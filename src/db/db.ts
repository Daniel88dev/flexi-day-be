import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import { schema } from "./schema/index.js";

const isProd = config.api.env === "production";

export const db = drizzle({
  connection: {
    connectionString: config.db.database,
    ssl: isProd
      ? {
          rejectUnauthorized: true,
        }
      : undefined,
  },
  schema,
});
