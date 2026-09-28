import type request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../../db/db.js";
import { session as sessionTable } from "../../../db/schema/auth-schema.js";

const APP_SCHEME = "flexiday://";

export const setCookiesOf = (res: request.Response): string[] =>
  (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];

/**
 * The last `Set-Cookie` entry for a name wins in every client, which is what
 * lets the after hook re-issue the session cookie the endpoint already wrote.
 */
export const lastCookie = (res: request.Response, name: string): string | undefined =>
  setCookiesOf(res)
    .filter((entry) => entry.startsWith(`${name}=`))
    .at(-1);

/** A `Cookie` header from a response, last value per name, as a client sends. */
export const cookieHeaderOf = (res: request.Response): string => {
  const jar = new Map<string, string>();
  for (const entry of setCookiesOf(res)) {
    const [pair] = entry.split(";");
    const name = pair?.split("=")[0];
    if (name && pair) jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
};

export const sessionsOf = (userId: string) =>
  db.select().from(sessionTable).where(eq(sessionTable.userId, userId));

export const yearsUntil = (date: Date) =>
  (date.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000);

export const nativeHeaders = (device: string, extra: Record<string, string> = {}) => ({
  "expo-origin": APP_SCHEME,
  "x-client-device-id": device,
  ...extra,
});
