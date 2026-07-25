// Loaded via `node --import ./dist/instrument.js` before the app graph so the SDK
// can instrument http/pg/express. Importing it normally would run too late (ESM).
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import dotenv from "dotenv";

dotenv.config();

// Public value, so it lives in code rather than secrets; SENTRY_DSN can override.
const SENTRY_DSN =
  process.env.SENTRY_DSN ??
  "https://b20be47db13f6b4d1ef6059b378c347d@o4507832619237376.ingest.de.sentry.io/4511796017365072";

// On in production only; opt in elsewhere with SENTRY_ENABLE=true.
const enabled = process.env.NODE_ENV === "production" || process.env.SENTRY_ENABLE === "true";

if (enabled) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV,
    // Must match the release used for `sentry-cli sourcemaps upload` (APP_VERSION, see Dockerfile).
    release: process.env.SENTRY_RELEASE ?? process.env.APP_VERSION,
    integrations: [nodeProfilingIntegration()],
    // Required for the winston -> Sentry Logs bridge in middleware/logger.ts.
    enableLogs: true,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 1.0),
    profileSessionSampleRate: 1.0,
    profileLifecycle: "trace",
    debug: process.env.SENTRY_DEBUG === "true",
  });
  console.log(`[sentry] initialized (environment=${process.env.NODE_ENV})`);
}
