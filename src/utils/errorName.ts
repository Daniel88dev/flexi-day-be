/** An error's class name, safe to log where its message might carry a token or personal data. */
export const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "unknown";
