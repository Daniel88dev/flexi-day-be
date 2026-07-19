import { createServer } from "./server.js";
import { config } from "./config.js";
import { logger } from "./middleware/logger.js";
import { db } from "./db/db.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import http from "http";

// Opt-in startup migrations: the production image has no drizzle-kit (dev
// dependency) and the database is only reachable from inside the VPC, so the
// deployed app itself is the only place migrations can run.
if (process.env.RUN_MIGRATIONS === "true") {
  const migrationsFolder =
    process.env.MIGRATIONS_FOLDER ?? "src/db/schema/out";
  logger.info(`Running database migrations from ${migrationsFolder}...`);
  try {
    await migrate(db, { migrationsFolder });
    logger.info("Database migrations completed");
  } catch (err) {
    logger.error({ msg: "Database migration failed", err });
    process.exit(1);
  }
}

const app = createServer();
export const server = http.createServer(app);

server.listen(config.api.port, () => {
  logger.info(`Server listening on port ${config.api.port}`);

  server.on("error", (err: unknown) => {
    if (err instanceof Error) {
      logger.error({ msg: "HTTP server error", err });
    } else {
      logger.error({ msg: "HTTP server error", err: String(err) });
    }
    process.exitCode = 1;
  });

  const shutdown = () => {
    logger.info("Shutting down HTTP server...");
    server.close((closeErr?: Error) => {
      if (closeErr) {
        logger.error({ msg: "Error shutting down HTTP server", err: closeErr });
        process.exitCode = 1;
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});
