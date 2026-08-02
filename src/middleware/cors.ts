import cors from "cors";
import { config } from "../config.js";

// Production origins come from the TRUSTED_ORIGINS env var (same list
// better-auth uses for CSRF protection), e.g. the CloudFront frontend URLs.
const allowedOrigins =
  config.api.env === "production"
    ? config.auth?.trustedOrigins ?? []
    : [/^http:\/\/localhost:(\d{2,5})$/];

export const serverCors = cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // `sentry-trace` and `baggage` let the frontend propagate its trace context
  // to the backend for distributed tracing (Sentry).
  // `x-dev-token` is only accepted outside production, where the local dev
  // routes exist and the frontend's dev sign-in page needs the preflight to pass.
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "sentry-trace",
    "baggage",
    "x-client-session-id",
    "x-client-device-id",
    ...(config.api.env === "production" ? [] : ["x-dev-token"]),
  ],
  // The report export sends its filename here; without exposing it the SPA
  // cannot read the header off the cross-origin response.
  exposedHeaders: ["Content-Disposition", "x-request-id"],
  credentials: true,
  optionsSuccessStatus: 204,
  maxAge: 7200,
});
