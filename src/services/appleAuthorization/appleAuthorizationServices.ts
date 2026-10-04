import { appleClient } from "../../utils/auth.js";
import { encryptOAuthToken } from "../../utils/oauthTokens.js";
import { findAppleAccounts, saveAppleTokens } from "./appleAccounts.js";
import { exchangeAppleAuthorizationCode } from "./appleTokenExchange.js";
import { AppleAuthorizationRefusal, type AppleAuthorizationOutcome } from "./types.js";

const refused = (refusal: AppleAuthorizationRefusal): AppleAuthorizationOutcome => ({
  stored: false,
  refusal,
});

/**
 * Stores the tokens behind a phone Apple sign-in on the caller's Apple link.
 * Every refusal leaves the row as it was.
 */
export async function storeAppleAuthorization(
  userId: string,
  authorizationCode: string
): Promise<AppleAuthorizationOutcome> {
  const links = await findAppleAccounts(userId);
  if (links.length === 0) return refused(AppleAuthorizationRefusal.AccountMissing);

  const exchanged = appleClient
    ? await exchangeAppleAuthorizationCode(appleClient, authorizationCode)
    : null;
  if (!exchanged) return refused(AppleAuthorizationRefusal.ExchangeFailed);

  const link = links.find((candidate) => candidate.accountId === exchanged.subject);
  if (!link) return refused(AppleAuthorizationRefusal.SubjectMismatch);

  await saveAppleTokens(link.id, {
    accessToken: await encryptOAuthToken(exchanged.accessToken),
    refreshToken: await encryptOAuthToken(exchanged.refreshToken),
    accessTokenExpiresAt: exchanged.accessTokenExpiresAt,
    idToken: exchanged.idToken,
  });
  return { stored: true };
}
