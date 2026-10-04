import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { vi } from "vitest";

export type TestSigningKey = { kid: string; alg: string; privateKey: CryptoKey; jwk: JWK };

/** A throwaway signing key and the public JWK a provider's key set would publish for it. */
export async function newSigningKey(kid: string, alg = "RS256"): Promise<TestSigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  return { kid, alg, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Signs `claims` as an id token, issued now and expiring in an hour unless the claims say otherwise. */
export function signIdToken(key: TestSigningKey, claims: JWTPayload) {
  return new SignJWT({ iat: nowSeconds(), exp: nowSeconds() + 3600, ...claims })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .sign(key.privateKey);
}

/**
 * Replaces `fetch` with one that serves `{ keys: served }` at `url` and 404s anywhere else.
 * `served` is read on every request, so a test rotates keys by mutating it.
 */
export function stubKeySet(url: string, served: JWK[]) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href !== url) return new Response("not found", { status: 404 });
    return Response.json({ keys: served });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
