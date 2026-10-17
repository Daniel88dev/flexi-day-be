import { parseEs256PrivateKey, signEs256Jwt } from "./es256Jwt.js";

const APPLE_AUDIENCE = "https://appleid.apple.com";
const LIFETIME_SECONDS = 60 * 60;
const REMINT_BELOW_SECONDS = 5 * 60;

type AppleSigningKey = {
  teamId: string;
  keyId: string;
  /** The `.p8` PEM, with real newlines or the literal `\n` a `.env` line carries. */
  privateKey: string;
};

/**
 * Apple has no static client secret: it is an ES256 JWT signed with the
 * Sign in with Apple key, and Apple refuses one whose `exp` lies more than six
 * months out. Each secret lives an hour and is re-minted once under five
 * minutes remain, so a long-running process never presents an expired one.
 *
 * `secretFor` is synchronous because better-auth reads `clientSecret` through
 * a plain property, which `buildSocialProviders` turns into a getter.
 */
export type AppleSecretMinter = { secretFor(sub: string): string };

export function createAppleSecretMinter({
  teamId,
  keyId,
  privateKey,
}: AppleSigningKey): AppleSecretMinter {
  const key = parseEs256PrivateKey(privateKey, "APPLE_PRIVATE_KEY");
  const cache = new Map<string, { secret: string; exp: number }>();

  return {
    secretFor(sub: string): string {
      const now = Math.floor(Date.now() / 1000);
      const cached = cache.get(sub);
      if (cached && cached.exp - now >= REMINT_BELOW_SECONDS) return cached.secret;

      const exp = now + LIFETIME_SECONDS;
      const secret = signEs256Jwt(key, keyId, {
        iss: teamId,
        sub,
        aud: APPLE_AUDIENCE,
        iat: now,
        exp,
      });

      cache.set(sub, { secret, exp });
      return secret;
    },
  };
}
