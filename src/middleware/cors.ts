import cors from "cors";
import { config } from "../config.js";

// Production origins come from the TRUSTED_ORIGINS env var (same list
// better-auth uses for CSRF protection), e.g. the CloudFront frontend URLs.
const allowedOrigins =
  config.api.env === "production"
    ? (config.auth?.trustedOrigins ?? [])
    : [/^http:\/\/localhost:(\d{2,5})$/];

export const serverCors = cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
});
