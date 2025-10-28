import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import { schema } from "./schema/index.js";

const isProd = config.api.env === "production";

/**
 * Represents the database instance initialized using the `drizzle` function.
 * This is used to manage database connections, execute queries, and interact
 * with the defined database schema.
 *
 * The database connection is configured using the provided connection details.
 * In production environments, SSL is enabled with `rejectUnauthorized` set to true.
 * Drops SSL for non-production environments.
 */
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
