// Loaded via `node --import ./dist/instrument.js` before the app graph so the SDK
// can instrument http/pg/express. Importing it normally would run too late (ESM).
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import dotenv from "dotenv";
import { sentryPrivacyAndSampling } from "./utils/sentryOptions.js";

dotenv.config();

// Public value, so it lives in code rather than secrets; SENTRY_DSN can override.
const SENTRY_DSN =
  process.env.SENTRY_DSN ??
  "https://b20be47db13f6b4d1ef6059b378c347d@o4507832619237376.ingest.de.sentry.io/4511796017365072";

// Must match the release used for `sentry-cli sourcemaps upload` (APP_VERSION, see Dockerfile).
const release = process.env.SENTRY_RELEASE || process.env.APP_VERSION;

// On for CI-built production images only. SENTRY_ENABLE=true forces it on anywhere and
// SENTRY_ENABLE=false forces it off, e.g. for a local run of an image pulled from ECR. The
// Dockerfile bakes in NODE_ENV=production, so a local `docker run` of that image would
// otherwise report as production. Only cd.yml passes a real APP_VERSION.
const enabled =
  process.env.SENTRY_ENABLE === "true" ||
  (process.env.SENTRY_ENABLE !== "false" &&
    process.env.NODE_ENV === "production" &&
    !!release &&
    release !== "unknown");

if (enabled) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release,
    integrations: [nodeProfilingIntegration()],
    ...sentryPrivacyAndSampling(process.env),
    // Profiling is trace-lifecycle-bound: it runs for the duration of every sampled
    // trace. Keep this low or an always-on server burns through the profile-hours
    // quota (24h/day/instance at 1.0). Overridable for targeted debugging.
    profileSessionSampleRate: Number(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? 0.1),
    profileLifecycle: "trace",
    debug: process.env.SENTRY_DEBUG === "true",
  });

  // Global scope attributes are merged into every log and error the process
  // emits, which is what makes them dependable columns in the Sentry Logs table.
  // Repeated as winston `defaultMeta` in middleware/logger.ts; identical keys
  // collapse into one attribute.
  Sentry.getGlobalScope().setAttributes({
    "service.name": process.env.SERVICE_NAME ?? "flexi-day-be",
    "service.version": process.env.APP_VERSION ?? "unknown",
    "service.type": "backend",
    "server.runtime": `node ${process.version}`,
  });

  console.log(`[sentry] initialized (environment=${process.env.NODE_ENV})`);
}
