import { z } from "zod";

export enum AppleAuthorizationRefusal {
  AccountMissing = "APPLE_ACCOUNT_MISSING",
  ExchangeFailed = "APPLE_EXCHANGE_FAILED",
  SubjectMismatch = "APPLE_SUBJECT_MISMATCH",
}

export const validatePostAppleAuthorization = z.object({
  authorizationCode: z.string().min(1).max(2048),
});

export type PostAppleAuthorizationBody = z.infer<typeof validatePostAppleAuthorization>;

/** One `account` row linking the user to an Apple ID; `accountId` is Apple's `sub`. */
export type AppleLink = { id: string; accountId: string };

/** What an Apple link holds; `saveAppleTokens` takes the access and refresh token encrypted. */
export type StoredAppleTokens = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  idToken: string;
};

/** Apple's answer to a code, in plaintext, with the subject of its verified id token. */
export type AppleExchange = StoredAppleTokens & { subject: string };

export type AppleAuthorizationOutcome =
  { stored: true } | { stored: false; refusal: AppleAuthorizationRefusal };
