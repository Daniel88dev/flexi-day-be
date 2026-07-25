import { createLogger, format, transports } from "winston";
import TransportStream from "winston-transport";
import * as Sentry from "@sentry/node";
import path from "node:path";
import fs from "node:fs";

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

// Forward winston logs to Sentry Logs when the SDK is active. instrument.ts inits
// Sentry (via --import) before this module, so isEnabled() is reliable here; when
// off (dev/tests) this is a no-op.
const sentryTransports: TransportStream[] = [];
if (Sentry.isEnabled()) {
  const SentryWinstonTransport = Sentry.createSentryWinstonTransport(TransportStream);
  sentryTransports.push(new SentryWinstonTransport());
}

const appVersion = process.env.APP_VERSION ?? process.env.npm_package_version ?? "unknown";

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
  transports: [new transports.Console(), ...fileTransports, ...sentryTransports],
});
