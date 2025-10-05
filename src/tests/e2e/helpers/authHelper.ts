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

export function createAuthCookie(sessionToken: string): string {
  return `better-auth.session_token=${sessionToken}`;
}

export async function deleteTestSession(sessionToken: string) {
  await db.delete(session).where(eq(session.token, sessionToken));
}
