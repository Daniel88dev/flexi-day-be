/** The `error` code in an Apple endpoint's JSON error body, if it carries one. */
export const errorCodeOf = (body: unknown) =>
  typeof body === "object" && body !== null && "error" in body ? String(body.error) : undefined;
