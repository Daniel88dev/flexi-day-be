import type { Request } from "express";

const REDACTED = "[redacted]";

// `token` and `code` cover better-auth's verification/reset links and group
// invite codes: anyone reading one out of a log could complete the flow.
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "code",
  "secret",
  "password",
  "key",
  "apikey",
  "callbackurl",
  "email",
]);

// The iCalendar feed authenticates with a long-lived token in the *path*, so
// query redaction alone would not cover it.
const CALENDAR_FEED = /^\/calendars\/[^/]+\.ics$/;

export const redactPath = (path: string): string =>
  CALENDAR_FEED.test(path) ? "/calendars/:token.ics" : path;

export const redactQuery = (query: Request["query"]): string | undefined => {
  const entries = Object.entries(query ?? {});
  if (!entries.length) return undefined;

  const parts = entries.map(([key, value]) => {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return `${key}=${REDACTED}`;
    // Joined/flattened because Sentry attributes must be scalars.
    if (Array.isArray(value)) return `${key}=${value.map(String).join(",")}`;
    if (typeof value === "string") return `${key}=${value}`;
    return `${key}=[object]`;
  });

  return parts.join("&");
};
