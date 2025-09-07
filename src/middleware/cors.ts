import cors from "cors";
import { config } from "../config.js";

const allowedOrigins =
  config.api.env === "production"
    ? [
        /* todo add production url's */
      ]
    : [/^http:\/\/localhost:(\d{2,5})$/];

export const serverCors = cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
});
