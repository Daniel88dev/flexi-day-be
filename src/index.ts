import { createServer } from "./server.js";
import { config } from "./config.js";
import { logger } from "./middleware/logger.js";

const server = createServer();

server.listen(config.api.port, () => {
  logger.info(`Server listening on port ${config.api.port}`);
});
