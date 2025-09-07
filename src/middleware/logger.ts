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

export const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  defaultMeta: {
    service: "Wallet Savior",
    buildInfo: {
      version: "0.1.0",
      nodeVersion: process.version,
    },
  },
  transports: [new transports.Console(), ...fileTransports],
});
