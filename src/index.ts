// NOTE: Sentry is initialized via `node --import ./dist/instrument.js` (see the
// start/dev scripts and Dockerfile CMD). ESM hoists imports, so an in-file
// `import "./instrument.js"` runs too late to instrument express/pg/http —
// `--import` is the only reliable way to load it before the app graph.
import { createServer } from "./server.js";
import { config } from "./config.js";
import { logger } from "./middleware/logger.js";
import http from "http";

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
