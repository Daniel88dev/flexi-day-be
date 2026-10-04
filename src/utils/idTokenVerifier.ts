import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type IdTokenVerifier = (token: string, nonce?: string) => Promise<boolean>;

type IdTokenRules = {
  keysUrl: string;
  issuer?: string | string[];
  audience: string;
  nonceComparison?: "exact" | "exact-or-sha256";
  verifyClaims?: (claims: JWTPayload) => boolean;
};

const MAX_TOKEN_AGE = "1h";

function nonceMatches(
  claimed: unknown,
  nonce: string,
  comparison: IdTokenRules["nonceComparison"] = "exact"
) {
  if (typeof claimed !== "string") return false;
  if (claimed === nonce) return true;
  return (
    comparison === "exact-or-sha256" && claimed === createHash("sha256").update(nonce).digest("hex")
  );
}

/**
 * The phone signs in by posting a provider's id token to `/sign-in/social`, and
 * better-auth's stock check downloads the provider's whole key set for every
 * one of them. This verifier holds the set in `jose`'s remote key set instead:
 * one download, shared by concurrent callers, refreshed when it ages out or
 * when a token names an unknown key id.
 *
 * better-auth runs nothing else once a provider has `verifyIdToken`, so the
 * rules below repeat its own: issuer, audience, RS256, expiry, an hour's
 * maximum age, the nonce only when the request carries one.
 */
export function createIdTokenVerifier(rules: IdTokenRules): IdTokenVerifier {
  const keys = createRemoteJWKSet(new URL(rules.keysUrl));

  return async (token, nonce) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: rules.issuer,
        audience: rules.audience,
        algorithms: ["RS256"],
        maxTokenAge: MAX_TOKEN_AGE,
      });
      if (nonce && !nonceMatches(payload.nonce, nonce, rules.nonceComparison)) return false;
      return rules.verifyClaims ? rules.verifyClaims(payload) : true;
    } catch {
      return false;
    }
  };
}

export function googleIdTokenVerifier(clientId: string) {
  return createIdTokenVerifier({
    keysUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });
}

const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const MULTI_TENANT = new Set(["common", "organizations", "consumers"]);

/**
 * On a multi-tenant endpoint the issuer varies with the account, so it is
 * checked against the token's own `tid`, and the account class against the
 * configured restriction, as better-auth's Microsoft provider does.
 * Its keys carry no `alg`, which better-auth's stock import refuses.
 */
export function microsoftIdTokenVerifier(clientId: string, tenant: string) {
  return createIdTokenVerifier({
    keysUrl: `${MICROSOFT_AUTHORITY}/${tenant}/discovery/v2.0/keys`,
    issuer: MULTI_TENANT.has(tenant) ? undefined : `${MICROSOFT_AUTHORITY}/${tenant}/v2.0`,
    audience: clientId,
    verifyClaims: ({ tid, iss }) => {
      if (typeof tid !== "string" || iss !== `${MICROSOFT_AUTHORITY}/${tid}/v2.0`) return false;
      if (tenant === "organizations") return tid !== MICROSOFT_CONSUMER_TENANT_ID;
      if (tenant === "consumers") return tid === MICROSOFT_CONSUMER_TENANT_ID;
      return true;
    },
  });
}

/** An app may hand Apple the SHA-256 of its nonce rather than the nonce, so either form matches. */
export function appleIdTokenVerifier(bundleId: string) {
  return createIdTokenVerifier({
    keysUrl: "https://appleid.apple.com/auth/keys",
    issuer: "https://appleid.apple.com",
    audience: bundleId,
    nonceComparison: "exact-or-sha256",
  });
}
