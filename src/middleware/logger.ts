import { createLogger, format, transports } from "winston";
import TransportStream from "winston-transport";
import * as Sentry from "@sentry/node";
import path from "node:path";
import fs from "node:fs";
import { getRequestContext } from "../utils/requestStore.js";
import { isSensitiveErrorProperty } from "../utils/redact.js";

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

// Per entry, not `defaultMeta` — winston evaluates that once at construction.
// Keys match the Sentry scope attributes `requestContext` sets, so the two
// sources collapse into one attribute instead of arriving under two spellings.
const requestContextFormat = format((info) => {
  const ctx = getRequestContext();
  if (!ctx) return info;
  return {
    ...info,
    "request.id": ctx.requestId,
    "http.request.method": ctx.method,
    "url.path": ctx.path,
    ...(ctx.query ? { "url.query": ctx.query } : {}),
    ...(ctx.userAgent ? { "user_agent.original": ctx.userAgent } : {}),
    ...(ctx.userId ? { "user.id": ctx.userId } : {}),
    ...(ctx.clientSessionId ? { "client.session_id": ctx.clientSessionId } : {}),
    ...(ctx.clientDeviceId ? { "client.device_id": ctx.clientDeviceId } : {}),
  };
});

// `JSON.stringify(new Error("x"))` is `{}` — message and stack are
// non-enumerable — so `logger.error("...", { error })` would log nothing.
const errorSerializerFormat = format((info) => {
  // Spread rather than rebuild: winston keys level/message/splat by symbol.
  const out: Record<string, unknown> = { ...info };
  for (const [key, value] of Object.entries(out)) {
    if (!(value instanceof Error)) continue;
    Reflect.deleteProperty(out, key);

    // Own enumerable scalars first, so the standard fields below win on a clash.
    // This is where Node's `code`/`errno`/`syscall` and pg's `detail`/
    // `constraint` live — the fields that actually identify a failure.
    for (const [prop, propValue] of Object.entries(value)) {
      if (["string", "number", "boolean"].includes(typeof propValue)) {
        out[`${key}.${prop}`] = isSensitiveErrorProperty(prop) ? "[redacted]" : propValue;
      }
    }

    out[`${key}.name`] = value.name;
    out[`${key}.message`] = value.message;
    out[`${key}.stack`] = value.stack;
    if (value.cause instanceof Error) out[`${key}.cause`] = value.cause.message;
  }
  return out as typeof info;
});

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "debug",
  format: format.combine(
    errorSerializerFormat(),
    requestContextFormat(),
    format.timestamp(),
    format.json()
  ),
  // Flat: Sentry attributes are scalars, so a nested object would arrive as one
  // blob you cannot filter on. Keys match instrument.ts's global scope.
  defaultMeta: {
    "service.name": process.env.SERVICE_NAME ?? "flexi-day-be",
    "service.version": appVersion,
    "service.type": "backend",
    "server.runtime": `node ${process.version}`,
  },
  transports: [new transports.Console(), ...fileTransports, ...sentryTransports],
});
