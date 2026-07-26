import { db } from "../../../db/db.js";
import { session } from "../../../db/schema/auth-schema.js";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import crypto from "crypto";

export async function createTestSession(userId: string): Promise<string> {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const sessionId = uuidv4();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await db.insert(session).values({
    id: sessionId,
    userId,
    token: sessionToken,
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return sessionToken;
}

/**
 * better-auth rejects an unsigned session cookie, so the token has to carry
 * the same HMAC the server would have attached at sign-in: standard base64
 * (not base64url) of HMAC-SHA256(secret, token), appended after a dot.
 */
export function createAuthCookie(sessionToken: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required to sign a test session cookie");

  const signature = crypto.createHmac("sha256", secret).update(sessionToken).digest("base64");

  return `better-auth.session_token=${sessionToken}.${signature}`;
}

/** Creates a session for the user and returns the ready-to-send Cookie header. */
export async function authCookieFor(userId: string): Promise<string> {
  return createAuthCookie(await createTestSession(userId));
}

export async function deleteTestSession(sessionToken: string) {
  await db.delete(session).where(eq(session.token, sessionToken));
}
