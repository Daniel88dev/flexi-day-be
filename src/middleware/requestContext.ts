import type { NextFunction, Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { generateRandomUUID } from "../utils/generateUUID.js";
import { runWithRequestContext, type RequestContext } from "../utils/requestStore.js";
import { redactMethod, redactPath, redactQuery } from "../utils/redact.js";
import { routeOf } from "../utils/routeTemplate.js";
import { logger } from "./logger.js";

// `/health` is the platform liveness probe (App Runner hits it every 10s), so it
// is silenced by default rather than via deploy-time config — it is this repo's
// own route, and relying on an env var to mute it has proven unreliable.
const IGNORED_PATHS = new Set([
  "/health",
  ...(process.env.REQUEST_LOG_IGNORE_PATHS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
]);

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
  const method = redactMethod(req.method);
  const startedAt = process.hrtime.bigint();

  const context: RequestContext = {
    requestId,
    clientSessionId,
    clientDeviceId,
    method,
    path,
    query,
    userAgent: header(req, "user-agent"),
  };

  runWithRequestContext(context, () => {
    // `@sentry/node` forks an isolation scope per request, so these stay
    // request-scoped and ride along on every log captured inside it.
    Sentry.setAttributes({
      "request.id": requestId,
      "http.request.method": method,
      "url.path": path,
      ...(query ? { "url.query": query } : {}),
      ...(clientSessionId ? { "client.session_id": clientSessionId } : {}),
      ...(clientDeviceId ? { "client.device_id": clientDeviceId } : {}),
    });
    // Attributes cover logs; tags are what makes error events searchable.
    Sentry.setTag("request_id", requestId);
    if (clientSessionId) Sentry.setTag("client_session_id", clientSessionId);

    // The redacted path, so a templated route like `/calendars/:token.ics` can
    // be silenced — its raw path differs on every request.
    const ignored = IGNORED_PATHS.has(path);

    if (!ignored) {
      logger.info(`${method} ${path}`, { "http.event": "request" });
    }

    // `finish` does not fire for a client that disconnects mid-request, which
    // is why the line above is emitted up front rather than only here.
    // Re-entered explicitly: an event listener does not inherit the async
    // context it was registered in.
    res.on("finish", () => {
      // Silencing a path drops its successful traffic, which is the noise, but
      // never a failure — an unhealthy probe is the one time it matters.
      if (ignored && res.statusCode < 400) return;

      runWithRequestContext(context, () => {
        logger.info(`${method} ${path} ${res.statusCode}`, {
          "http.event": "response",
          "http.response.status_code": res.statusCode,
          "http.route": routeOf(req) ?? path,
          duration_ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
        });
      });
    });

    next();
  });
};
