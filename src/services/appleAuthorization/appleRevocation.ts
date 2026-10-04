import { decodeJwt } from "jose";
import { logger } from "../../middleware/logger.js";
import type { AppleClient } from "../../utils/socialProviders.js";
import { errorCodeOf } from "./appleErrorCode.js";
import type { AppleRevocation, StoredAppleLink } from "./types.js";

const REVOKE_ENDPOINT = "https://appleid.apple.com/auth/revoke";
const TIMEOUT_MS = 10_000;

/**
 * Apple revokes a token only for the client it was issued to: the Services ID
 * for a web link, the bundle id for a phone link. The stored id token names it.
 * Decoded, not verified: this server verified it before storing it.
 */
const audienceOf = (idToken: string | null | undefined, servicesId: string): string => {
  if (!idToken) return servicesId;
  try {
    const { aud } = decodeJwt(idToken);
    return (Array.isArray(aud) ? aud[0] : aud) || servicesId;
  } catch {
    return servicesId;
  }
};

/** Never throws: an unreadable token becomes no token. */
export async function appleRevocationOf(
  link: StoredAppleLink,
  servicesId: string,
  decrypt: (stored: string) => string | Promise<string>
): Promise<AppleRevocation> {
  let refreshToken: string | null = null;
  if (link.refreshToken) {
    try {
      refreshToken = await decrypt(link.refreshToken);
    } catch (error) {
      logger.warn("apple.revoke.unreadable_token", {
        userId: link.userId,
        linkId: link.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { linkId: link.id, audience: audienceOf(link.idToken, servicesId), refreshToken };
}

async function revokeOne(
  client: AppleClient,
  userId: string,
  { linkId, audience, refreshToken }: AppleRevocation
): Promise<void> {
  if (!refreshToken) {
    logger.warn("apple.revoke.no_token", { userId, linkId });
    return;
  }

  let response: Response;
  try {
    response = await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: audience,
        client_secret: client.minter.secretFor(audience),
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    logger.error("apple.revoke.unreachable", {
      userId,
      linkId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    logger.error("apple.revoke.rejected", {
      userId,
      linkId,
      status: response.status,
      "apple.error": errorCodeOf(body),
    });
    return;
  }
  logger.info("apple.revoke.revoked", { userId, linkId, audience });
}

/**
 * Revokes each link at Apple, so the user's Apple settings stop listing the
 * app. Best effort: every failure is logged by user id and none is thrown, so
 * the deletion or unlink it follows answers as it would have anyway. Without
 * an Apple client there is no key to sign with, so nothing is revoked.
 */
export async function revokeAtApple(
  client: AppleClient | undefined,
  userId: string,
  revocations: AppleRevocation[]
): Promise<void> {
  if (!client) return;
  for (const revocation of revocations) {
    await revokeOne(client, userId, revocation);
  }
}
