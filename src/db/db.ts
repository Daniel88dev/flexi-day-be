import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import { schema } from "./schema/index.js";

const isProd = config.api.env === "production";

// Production verifies TLS against RDS (rejectUnauthorized); no SSL elsewhere.
export const db: NodePgDatabase<typeof schema> = drizzle({
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

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
