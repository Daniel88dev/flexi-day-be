import { createLogger, format, transports } from "winston";
import path from "node:path";
import fs from "node:fs";

// Ensure the logs directory exists
const LOG_DIR = path.resolve(process.cwd(), process.env.LOG_DIR ?? "logs");
let fileTransports: InstanceType<typeof transports.File>[] = [];

try {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fileTransports = [
    new transports.File({
      filename: path.join(LOG_DIR, "combined.log"),
      maxsize: 5_242_880,
      maxFiles: 5,
      tailable: true,
    }),
    new transports.File({
      filename: path.join(LOG_DIR, "error.log"),
      level: "error",
      maxsize: 5_242_880,
      maxFiles: 5,
      tailable: true,
    }),
  ];
} catch (error) {
  console.error(
    `Error creating logs directory at "${LOG_DIR}". Falling back to console-only logging.`,
    error
  );
}

const appVersion =
  process.env.APP_VERSION ?? process.env.npm_package_version ?? "unknown";

/**
 * Logger instance configured for the application.
 *
 * This logger is pre-configured with the following settings:
 * - Log level: "info"
 * - Log format: Combines timestamp and JSON format
 * - Default metadata: Includes service name and build information
 * - Transports: Outputs to the console and additional file transports
 *
 * Default metadata contains:
 * - `service`: Name of the service ("Flexi Day")
 * - `buildInfo`: Object containing build information including:
 *   - `version`: Version of the software
 *   - `nodeVersion`: Node.js version
 *
 * The logger is intended for capturing and managing application logs consistently across the system.
 */
export const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  defaultMeta: {
    service: process.env.SERVICE_NAME ?? "Flexi Day",
    buildInfo: {
      version: appVersion,
      nodeVersion: process.version,
    },
  },
  transports: [new transports.Console(), ...fileTransports],
});
