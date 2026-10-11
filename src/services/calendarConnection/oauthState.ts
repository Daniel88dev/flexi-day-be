import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { calendarProvider } from "../../db/schema/calendar-connection-schema.js";
import AppError from "../../utils/appError.js";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** `publicContext.code` when the callback's state is missing, forged, foreign or expired. */
export const CALENDAR_SYNC_STATE_INVALID = "CALENDAR_SYNC_STATE_INVALID";

const MAX_STATE_LENGTH = 2048;

// Keeps this signature from ever matching another HMAC made with the same secret.
const DOMAIN = "flexi-day.calendar-sync-state.v1";

export type OAuthStateInput = {
  userId: string;
  configId: string;
  timeZone: string;
  provider: calendarProvider;
};

const payloadSchema = z.object({
  userId: z.string().min(1),
  configId: z.string().min(1),
  timeZone: z.string().min(1),
  provider: z.enum(calendarProvider),
  nonce: z.string().min(16),
  exp: z.number().int(),
});

export type OAuthStatePayload = z.infer<typeof payloadSchema>;

const sign = (encoded: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(`${DOMAIN}.${encoded}`).digest();

const invalid = (reason: string) =>
  new AppError({
    code: 400,
    message: "The connection request is invalid or has expired",
    publicContext: { code: CALENDAR_SYNC_STATE_INVALID },
    context: { reason },
  });

export const signOAuthState = (
  input: OAuthStateInput,
  secret: string,
  now: number = Date.now()
): string => {
  const payload: OAuthStatePayload = {
    userId: input.userId,
    configId: input.configId,
    timeZone: input.timeZone,
    provider: input.provider,
    nonce: randomBytes(16).toString("base64url"),
    exp: now + OAUTH_STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret).toString("base64url")}`;
};

/** Throws a 400 `CALENDAR_SYNC_STATE_INVALID` unless the state is genuine, unexpired and for `provider`. */
export const verifyOAuthState = (
  state: unknown,
  provider: calendarProvider,
  secret: string,
  now: number = Date.now()
): OAuthStatePayload => {
  if (typeof state !== "string" || state.length === 0 || state.length > MAX_STATE_LENGTH) {
    throw invalid("malformed");
  }
  const parts = state.split(".");
  if (parts.length !== 2) throw invalid("malformed");
  const [encoded, signature] = parts as [string, string];

  const expected = sign(encoded, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw invalid("signature");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalid("malformed");
  }
  const result = payloadSchema.safeParse(parsed);
  if (!result.success) throw invalid("malformed");

  const payload = result.data;
  if (payload.exp < now) throw invalid("expired");
  if (payload.provider !== provider) throw invalid("provider");
  return payload;
};
