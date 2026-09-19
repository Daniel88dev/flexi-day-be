import { APIError } from "better-auth/api";
import { readNativeClient, type HeaderSource, type NativeClient } from "./clientHeaders.js";

/**
 * Ten years, in seconds. A cookie cannot say this: better-call caps one at 400
 * days and throws above it. So the native session cookie carries no expiry at
 * all, the phone holds it until the server ends it, and the row is the only
 * lifetime there is.
 */
export const NATIVE_SESSION_TTL = 10 * 365 * 24 * 60 * 60;

export const NATIVE_SESSION_TTL_MS = NATIVE_SESSION_TTL * 1000;

export const nativeSessionExpiresAt = (from: Date = new Date()): Date =>
  new Date(from.getTime() + NATIVE_SESSION_TTL_MS);

/**
 * Structurally a better-auth endpoint context. A database hook receives one
 * only while a request is in flight, and it carries the headers either
 * directly or on the `Request` it was built from.
 */
type RequestContext = {
  headers?: HeaderSource | null | undefined;
  request?: { headers?: HeaderSource | null | undefined } | null | undefined;
};

export const nativeClientOf = (context: RequestContext | null | undefined): NativeClient | null =>
  readNativeClient(context?.headers ?? context?.request?.headers);

export type NativeSessionStamp = NativeClient & { expiresAt: Date };

/**
 * What a session row created for this request gains when the request is from
 * the phone: the three columns and a flat ten-year expiry. Null for every web
 * request, which leaves better-auth's own defaults in place.
 */
export const nativeSessionStamp = (
  context: RequestContext | null | undefined,
  now: Date = new Date()
): NativeSessionStamp | null => {
  const client = nativeClientOf(context);
  if (!client) return null;

  return { ...client, expiresAt: nativeSessionExpiresAt(now) };
};

/** A request context after the endpoint has answered, with what it answered. */
type AfterContext = RequestContext & {
  context?:
    | {
        newSession?: { session?: { id?: string | null } | null } | null | undefined;
        returned?: unknown;
      }
    | null
    | undefined;
};

/** What the twoFactor plugin answers a sign-in with when it still owes a code. */
const isTwoFactorRedirect = (returned: unknown): boolean =>
  typeof returned === "object" &&
  returned !== null &&
  (returned as { twoFactorRedirect?: unknown }).twoFactorRedirect === true;

/** The phone a response signed in, and the one session it is left holding. */
export type NativeSessionEviction = { deviceId: string; keepSessionId: string };

/**
 * One phone, one session: whose other sessions this response ends. Null for a
 * web request, for a response that carries no new session, and for the
 * two-factor redirect — its pre-challenge session is a throwaway, so a
 * challenge nobody finishes must leave the phone's existing session standing.
 */
export const nativeSessionEviction = (
  context: AfterContext | null | undefined
): NativeSessionEviction | null => {
  const client = nativeClientOf(context);
  const keepSessionId = context?.context?.newSession?.session?.id;
  if (!client || !keepSessionId) return null;
  if (isTwoFactorRedirect(context.context?.returned)) return null;

  return { deviceId: client.deviceId, keepSessionId };
};

/**
 * The contract with the phone app: this code, and nothing else, is what tells
 * it to wipe its cookie jar, session cache and local store.
 */
export const SESSION_DEVICE_MISMATCH = "SESSION_DEVICE_MISMATCH";

export const SESSION_DEVICE_MISMATCH_MESSAGE = "Session is bound to another device";

/** An unbound session — every web one — is false whatever the request carries. */
export const isDeviceMismatch = (
  sessionDeviceId: string | null | undefined,
  requestDeviceId: string | null | undefined
): boolean => Boolean(sessionDeviceId) && sessionDeviceId !== requestDeviceId;

export const deviceMismatchError = (): APIError =>
  new APIError("UNAUTHORIZED", {
    message: SESSION_DEVICE_MISMATCH_MESSAGE,
    code: SESSION_DEVICE_MISMATCH,
  });

/** The same error on the Express side, where `auth.api` rejected rather than answered. */
export const isDeviceMismatchError = (error: unknown): boolean =>
  error instanceof APIError &&
  (error.body as { code?: string } | undefined)?.code === SESSION_DEVICE_MISMATCH;
