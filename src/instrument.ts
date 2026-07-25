// Sentry initialization. This file MUST be imported before any other module
// (see the first line of `index.ts`) so the SDK can instrument `http`, `pg`,
// `express`, etc. before they are loaded.
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import dotenv from "dotenv";

dotenv.config();

// The DSN is public (like the frontend's), so it lives in code rather than in
// Terraform/secrets. A SENTRY_DSN env var can still override it if ever needed.
const SENTRY_DSN =
  process.env.SENTRY_DSN ??
  "https://b20be47db13f6b4d1ef6059b378c347d@o4507832619237376.ingest.de.sentry.io/4511796017365072";

// Sentry runs automatically in production. Elsewhere (local dev) it stays off
// so dev and tests don't ship noise/quota — opt in with SENTRY_ENABLE=true.
const enabled = process.env.NODE_ENV === "production" || process.env.SENTRY_ENABLE === "true";

if (enabled) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV,
    // Must match the release passed to `sentry-cli sourcemaps upload` at build
    // time (APP_VERSION is the git SHA stamped by CI, see Dockerfile) so stack
    // traces resolve against the uploaded source maps.
    release: process.env.SENTRY_RELEASE ?? process.env.APP_VERSION,
    integrations: [nodeProfilingIntegration()],

    // Send structured logs (Sentry.logger.*) to Sentry.
    enableLogs: true,

    // Tracing. Override via SENTRY_TRACES_SAMPLE_RATE; defaults to 100%.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 1.0),

    // Profiling is evaluated once per SDK.init; "trace" lifecycle ties it to
    // active traces so only sampled transactions are profiled.
    profileSessionSampleRate: 1.0,
    profileLifecycle: "trace",

    // Opt-in verbose SDK logging for troubleshooting delivery.
    debug: process.env.SENTRY_DEBUG === "true",
  });
  // eslint-disable-next-line no-console
  console.log(`[sentry] initialized (environment=${process.env.NODE_ENV})`);
}
