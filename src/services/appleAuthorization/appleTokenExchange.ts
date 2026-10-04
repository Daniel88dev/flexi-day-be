import { z } from "zod";
import { logger } from "../../middleware/logger.js";
import type { AppleClient } from "../../utils/socialProviders.js";
import type { AppleExchange } from "./types.js";

const TOKEN_ENDPOINT = "https://appleid.apple.com/auth/token";
const TIMEOUT_MS = 10_000;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
});

const errorCodeOf = (body: unknown) =>
  typeof body === "object" && body !== null && "error" in body ? String(body.error) : undefined;

/**
 * Trades the phone's one-time authorization code for Apple's tokens, as the
 * app: the code was issued to the bundle id, so that is the client and the
 * secret's subject. No redirect URI, because the native sheet used none.
 * Null for every failure, already logged.
 */
export async function exchangeAppleAuthorizationCode(
  client: AppleClient,
  code: string
): Promise<AppleExchange | null> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: client.bundleId,
        client_secret: client.minter.secretFor(client.bundleId),
        code,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("apple.token_exchange.unreachable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    logger.warn("apple.token_exchange.rejected", {
      status: response.status,
      "apple.error": errorCodeOf(body),
    });
    return null;
  }

  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) {
    logger.warn("apple.token_exchange.incomplete", {
      missing: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
    return null;
  }

  const claims = await client.readIdToken(parsed.data.id_token);
  if (typeof claims?.sub !== "string") {
    logger.warn("apple.token_exchange.unverified_id_token");
    return null;
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    accessTokenExpiresAt: new Date(Date.now() + parsed.data.expires_in * 1000),
    idToken: parsed.data.id_token,
    subject: claims.sub,
  };
}
