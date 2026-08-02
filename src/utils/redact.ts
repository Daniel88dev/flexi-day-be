import type { Request } from "express";

const REDACTED = "[redacted]";
const MAX_QUERY_LENGTH = 512;

// `token` and `code` cover better-auth's verification/reset links and group
// invite codes: anyone reading one out of a log could complete the flow.
const SENSITIVE_EXACT = new Set([
  "token",
  "code",
  "secret",
  "password",
  "key",
  "apikey",
  "callbackurl",
  "email",
]);

// Substring match so `invitedEmail` and `resetToken` are caught too.
const SENSITIVE_PARTS = ["email", "token", "password", "secret", "credential", "authorization"];

export const isSensitiveKey = (key: string): boolean => {
  const k = key.toLowerCase();
  return SENSITIVE_EXACT.has(k) || SENSITIVE_PARTS.some((part) => k.includes(part));
};

// Deliberately looser than `isSensitiveKey`: on an Error, `code` is
// `ECONNREFUSED` and `key` is a column name, not a secret. Redacting those
// would throw away the fields that identify the failure.
export const isSensitiveErrorProperty = (key: string): boolean => {
  const k = key.toLowerCase();
  return SENSITIVE_PARTS.some((part) => k.includes(part));
};

// Attacker-controlled and headed into a flattened `key=value&…` string, so
// delimiters are escaped rather than left to read as extra parameters.
// Stripping control characters is the whole point of this expression.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

const sanitizeValue = (value: string): string =>
  value.replace(CONTROL_CHARS, "").replace(/&/g, "%26").replace(/=/g, "%3D");

// The iCalendar feed authenticates with a long-lived token in the *path*, so
// query redaction alone would not cover it.
const CALENDAR_FEED = /^\/calendars\/[^/]+\.ics$/;

// Control characters are stripped because both values are interpolated into log
// messages, where a surviving CR/LF would let a caller forge a whole log line.
export const redactPath = (path: string): string =>
  CALENDAR_FEED.test(path) ? "/calendars/:token.ics" : path.replace(CONTROL_CHARS, "");

// Node's parser already rejects a method outside the HTTP token grammar, so this
// only matters if that ever stops being true.
export const redactMethod = (method: string): string => method.replace(CONTROL_CHARS, "");

export const redactQuery = (query: Request["query"]): string | undefined => {
  const entries = Object.entries(query ?? {});
  if (!entries.length) return undefined;

  const parts = entries.map(([key, value]) => {
    if (isSensitiveKey(key)) return `${key}=${REDACTED}`;
    // Joined/flattened because Sentry attributes must be scalars.
    if (Array.isArray(value)) {
      const items = value.map((v) => (typeof v === "string" ? sanitizeValue(v) : "[object]"));
      return `${key}=${items.join(",")}`;
    }
    if (typeof value === "string") return `${key}=${sanitizeValue(value)}`;
    return `${key}=[object]`;
  });

  const joined = parts.join("&");
  return joined.length > MAX_QUERY_LENGTH ? `${joined.slice(0, MAX_QUERY_LENGTH)}…` : joined;
};

// `AppError.context` is internal but logged verbatim, so it reaches Sentry. The
// sign-up and invite paths put the user's email in there.
export const redactObject = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      Object.assign(out, {
        [key]: isSensitiveKey(key) ? REDACTED : redactObject(nested, depth + 1),
      });
    }
    return out;
  }
  return value;
};
