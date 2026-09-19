import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { hashPassword } from "better-auth/crypto";
import { db } from "../../../db/db.js";
import { account, user } from "../../../db/schema/auth-schema.js";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  deleteSessionByToken,
  sessionCookieHeader,
} from "../../../utils/devSession.js";

// Thin aliases over the shared session helpers so the e2e suite and the local
// dev routes cannot drift apart on cookie signing.

export async function createTestSession(userId: string): Promise<string> {
  return createSessionToken(userId);
}

export function createAuthCookie(sessionToken: string): string {
  return sessionCookieHeader(sessionToken);
}

/** Creates a session for the user and returns the ready-to-send Cookie header. */
export async function authCookieFor(userId: string): Promise<string> {
  return createAuthCookie(await createTestSession(userId));
}

export async function deleteTestSession(sessionToken: string) {
  await deleteSessionByToken(sessionToken);
}

export const WEB_TEST_PASSWORD = "sturdy-passphrase-42";

/**
 * A user who can sign in over HTTP. The `credential` row is inserted rather
 * than signed up for the same reason the dev seeder inserts it: `signUpEmail`
 * runs the haveIBeenPwned check, an outbound call, and sends a verification
 * email through SES.
 */
export async function createWebUser(name: string): Promise<{ id: string; email: string }> {
  const id = uuidv4();
  const email = `web-${id}@report-e2e.test`;
  await db.insert(user).values({
    id,
    email,
    name,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(account).values({
    id: uuidv4(),
    userId: id,
    providerId: "credential",
    accountId: id,
    password: await hashPassword(WEB_TEST_PASSWORD),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id, email };
}

/**
 * The Cookie header better-auth itself hands out at sign-in — the web session,
 * as opposed to the signed cookie `authCookieFor` and `/api/dev/session` mint.
 */
export async function webSessionCookieFor(app: Express, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/sign-in/email")
    .send({ email, password: WEB_TEST_PASSWORD });

  if (res.status !== 200) {
    throw new Error(`sign-in for ${email} answered ${res.status.toString()}`);
  }

  const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = (setCookie ?? []).map((value) => value.split(";")[0]).join("; ");
  if (!cookie.includes(`${SESSION_COOKIE_NAME}=`)) {
    throw new Error(`sign-in for ${email} set no session cookie`);
  }
  return cookie;
}
