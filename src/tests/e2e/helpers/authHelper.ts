import {
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
