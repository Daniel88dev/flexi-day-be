import type { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";

export type ProviderTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  /** Space-separated scopes the provider says it granted. */
  scope: string;
};

export type StoredTokens = {
  accessToken: string | null;
  expiresAt: Date | null;
  refreshToken: string;
};

export type FreshAccessToken = {
  accessToken: string;
  expiresAt: Date | null;
  /** The refresh token to keep: Microsoft rotates it on every refresh. */
  refreshToken: string;
  refreshed: boolean;
};

/** An access token this close to expiry is refreshed first. */
export const REFRESH_SKEW_MS = 60_000;

/** The user or an admin took the grant back; only a new consent round restores it. */
export class ProviderGrantRevokedError extends Error {
  constructor(public readonly reason: string) {
    super(`Calendar grant revoked: ${reason}`);
    this.name = "ProviderGrantRevokedError";
  }
}

/** Any other token-endpoint failure: network, 5xx, a malformed answer. */
export class ProviderTokenError extends Error {
  constructor(public readonly reason: string) {
    super(`Calendar token request failed: ${reason}`);
    this.name = "ProviderTokenError";
  }
}

export type OAuthClientOptions = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export interface CalendarProviderAdapter {
  provider: calendarProvider;
  /** True when the granted scope string covers what the sync needs. */
  grantsCalendarScope: (scope: string) => boolean;
  consentUrl: (state: string) => string;
  exchangeCode: (code: string) => Promise<ProviderTokens>;
  accessToken: (stored: StoredTokens, now?: number) => Promise<FreshAccessToken>;
  /** Best effort; Microsoft has no revoke endpoint and resolves without calling out. */
  revoke: (refreshToken: string) => Promise<void>;
}
