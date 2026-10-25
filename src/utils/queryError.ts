import { DrizzleQueryError } from "drizzle-orm";

const REDACTED = "[redacted]";
const QUERY_PREFIX = "Failed query: ";
const PARAMS_MARKER = "\nparams: ";

// Postgres data exceptions (SQLSTATE class 22) quote the rejected input back,
// as in `invalid input syntax for type uuid: "..."`. Other classes quote
// identifiers only, which is what makes them worth keeping.
const isDataException = (cause: unknown): boolean => {
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.startsWith("22");
};

const redactQuoted = (text: string): string => text.replace(/"[^"]*"/g, `"${REDACTED}"`);

const withoutParams = (text: string): string => {
  if (!text.startsWith(QUERY_PREFIX)) return text;
  const at = text.indexOf(PARAMS_MARKER);
  return at === -1 ? text : text.slice(0, at);
};

const scrubStack = (stack: string, original: string, message: string, name: string): string => {
  const at = stack.indexOf(original);
  if (at !== -1) return stack.slice(0, at) + message + stack.slice(at + original.length);
  const frames = stack.split("\n").filter((line) => /^\s+at /.test(line));
  return [`${name}: ${message}`, ...frames].join("\n");
};

/**
 * drizzle writes every bound value of a failed query into the error's message
 * (`params: ...`) and so into its stack. Returns a copy that keeps the
 * statement, the frames and the cause's SQLSTATE, and none of the values.
 */
export const scrubQueryError = (err: unknown): unknown => {
  if (!(err instanceof DrizzleQueryError)) return err;

  const message = `${QUERY_PREFIX}${err.query}`;
  const cause =
    err.cause instanceof Error
      ? Object.assign(
          new Error(
            isDataException(err.cause) ? redactQuoted(err.cause.message) : err.cause.message
          ),
          { code: (err.cause as { code?: unknown }).code }
        )
      : undefined;

  const scrubbed = new Error(message, cause ? { cause } : undefined);
  scrubbed.name = err.name;
  scrubbed.stack = err.stack && scrubStack(err.stack, err.message, message, err.name);
  return Object.assign(scrubbed, { query: err.query });
};

type ExceptionEvent = { exception?: { values?: { value?: string }[] } };

/**
 * Sentry's express integration captures a failed request's error where it is
 * thrown, before `errorMiddleware` runs, so the event needs the same scrub.
 */
export const scrubQueryErrorEvent = <E extends ExceptionEvent>(event: E, original: unknown): E => {
  if (!(original instanceof DrizzleQueryError)) return event;
  const dataException = isDataException(original.cause);
  for (const entry of event.exception?.values ?? []) {
    if (entry.value === undefined) continue;
    entry.value = entry.value.startsWith(QUERY_PREFIX)
      ? withoutParams(entry.value)
      : dataException
        ? redactQuoted(entry.value)
        : entry.value;
  }
  return event;
};
