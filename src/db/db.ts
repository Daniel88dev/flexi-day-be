import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { schema } from "./schema/index.js";

const isProd = config.api.env === "production";

// Production verifies TLS against RDS (rejectUnauthorized); no SSL elsewhere.
export const pool = new pg.Pool({
  connectionString: config.db.database,
  ssl: isProd
    ? {
        rejectUnauthorized: true,
      }
    : undefined,
});

// Without a listener, an idle connection the server drops (RDS restart, failover, class
// change) throws out of the EventEmitter and kills the process. The pool has already
// discarded the client, so the next query connects afresh.
pool.on("error", (error) => {
  logger.error("Database pool connection error", { error });
});

export const db: NodePgDatabase<typeof schema> = drizzle({ client: pool, schema });

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
