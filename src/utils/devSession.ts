import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { session } from "../db/schema/auth-schema.js";
import { generateRandomUUID } from "./generateUUID.js";

export const SESSION_COOKIE_NAME = "better-auth.session_token";

const SESSION_TTL_DAYS = 7;

/** Inserts a session row directly and returns its raw (unsigned) token. */
export async function createSessionToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);

  await db.insert(session).values({
    id: generateRandomUUID(),
    userId,
    token,
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return token;
}

/**
 * better-auth rejects an unsigned session cookie, so the token has to carry the
 * same HMAC the server would have attached at sign-in: standard base64 (not
 * base64url) of HMAC-SHA256(secret, token), appended after a dot.
 */
export function signSessionToken(token: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required to sign a session cookie");

  const signature = crypto.createHmac("sha256", secret).update(token).digest("base64");

  return `${token}.${signature}`;
}

/** Full `name=value` cookie string, ready to send as a `Cookie` header. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${signSessionToken(token)}`;
}

export async function deleteSessionByToken(token: string): Promise<void> {
  await db.delete(session).where(eq(session.token, token));
}
