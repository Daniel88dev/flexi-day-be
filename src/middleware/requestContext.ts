import type { NextFunction, Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { generateRandomUUID } from "../utils/generateUUID.js";
import { runWithRequestContext } from "../utils/requestStore.js";
import { redactPath, redactQuery } from "../utils/redactUrl.js";
import { logger } from "./logger.js";

const IGNORED_PATHS = new Set(
  (process.env.REQUEST_LOG_IGNORE_PATHS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Looser than UUID: upstream proxies mint their own ids. Still bounded.
const REQUEST_ID_PATTERN = /^[\w.:-]{1,200}$/;

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
};

// Attacker-controlled and headed for logs, so only the exact shape the frontend
// mints is accepted; anything else is dropped rather than half-sanitised.
const acceptClientId = (value: string | undefined): string | undefined =>
  value && UUID_PATTERN.test(value) ? value : undefined;

export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const inbound = header(req, "x-request-id");
  const requestId = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : generateRandomUUID();
  const clientSessionId = acceptClientId(header(req, "x-client-session-id"));
  const clientDeviceId = acceptClientId(header(req, "x-client-device-id"));

  res.setHeader("x-request-id", requestId);

  // Both carry secrets on some routes — see redactUrl.ts.
  const path = redactPath(req.path);
  const query = redactQuery(req.query);

  runWithRequestContext(
    {
      requestId,
      clientSessionId,
      clientDeviceId,
      method: req.method,
      path,
      query,
      userAgent: header(req, "user-agent"),
    },
    () => {
      // `@sentry/node` forks an isolation scope per request, so these stay
      // request-scoped and ride along on every log captured inside it.
      Sentry.setAttributes({
        "request.id": requestId,
        "http.request.method": req.method,
        "url.path": path,
        ...(query ? { "url.query": query } : {}),
        ...(clientSessionId ? { "client.session_id": clientSessionId } : {}),
        ...(clientDeviceId ? { "client.device_id": clientDeviceId } : {}),
      });
      // Attributes cover logs; tags are what makes error events searchable.
      Sentry.setTag("request_id", requestId);
      if (clientSessionId) Sentry.setTag("client_session_id", clientSessionId);

      if (!IGNORED_PATHS.has(req.path)) {
        logger.info(`${req.method} ${path}`, { "http.event": "request" });
      }

      next();
    }
  );
};
