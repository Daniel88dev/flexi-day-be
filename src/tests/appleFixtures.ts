import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import { appleClientFrom, buildSocialProviders } from "../utils/socialProviders.js";

/** A throwaway EC P-256 key, the curve Apple's `.p8` keys use. */
export function newP256Key() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

/** All five Apple values `buildSocialProviders` needs, signed by a fresh key unless one is given. */
export function appleCredentials(privateKey = newP256Key().pem) {
  return {
    appleClientId: "com.flexiday.web",
    appleTeamId: "TEAM123456",
    appleKeyId: "KEY1234567",
    appleAppBundleIdentifier: "com.flexiday.app",
    applePrivateKey: privateKey,
  };
}

/** Decodes a JWT's header (`0`) or payload (`1`) without checking the signature. */
export function decodeJwtPart(jwt: string | undefined, part: 0 | 1): Record<string, unknown> {
  const encoded = jwt?.split(".")[part] ?? "";
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** `buildSocialProviders` the way `auth.ts` calls it, with the Apple client built from the same values. */
export const socialProvidersFrom = (credentials?: Parameters<typeof appleClientFrom>[0]) =>
  buildSocialProviders(credentials, appleClientFrom(credentials));

/** An id token as an `account` row holds it, for code that only decodes it. */
export const storedIdToken = (claims: Record<string, unknown>) =>
  [{ alg: "RS256", kid: "apple-key-1" }, claims, "signature"]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");

export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

/**
 * Replaces `fetch` with one that answers Apple's revoke endpoint with 200, or
 * with what `answerWith` sets, and 404s anywhere else.
 */
export function stubAppleRevoke() {
  let answer = () => Promise.resolve(new Response(null, { status: 200 }));
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
    String(input) === APPLE_REVOKE_URL ? answer() : new Response("not found", { status: 404 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    answerWith(next: () => Promise<Response>) {
      answer = next;
    },
    /** The form body of every call to the revoke endpoint, in order. */
    revokeForms: () =>
      fetchMock.mock.calls
        .filter(([input]) => String(input) === APPLE_REVOKE_URL)
        .map(([, init]) => new URLSearchParams(String(init?.body))),
  };
}
