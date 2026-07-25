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
  allowedHeaders: ["Content-Type", "Authorization", "sentry-trace", "baggage"],
  credentials: true,
  optionsSuccessStatus: 204,
});
