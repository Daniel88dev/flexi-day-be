import { OAuth2Client, type OAuth2ClientOptions } from "google-auth-library";
import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import {
  ProviderGrantRevokedError,
  ProviderTokenError,
  REFRESH_SKEW_MS,
  type CalendarProviderAdapter,
  type OAuthClientOptions,
} from "./types.js";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";

const REQUEST_TIMEOUT_MS = 10_000;

const providerError = (error: unknown): string | undefined => {
  const data = (error as { response?: { data?: { error?: unknown } } }).response?.data;
  return typeof data?.error === "string" ? data.error : undefined;
};

const tokenError = (error: unknown): ProviderTokenError =>
  new ProviderTokenError(providerError(error) ?? (error instanceof Error ? error.name : "unknown"));

export const createGoogleAdapter = (
  options: OAuthClientOptions & { endpoints?: OAuth2ClientOptions["endpoints"] }
): CalendarProviderAdapter => {
  const client = () =>
    new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: options.redirectUri,
      endpoints: options.endpoints,
      eagerRefreshThresholdMillis: REFRESH_SKEW_MS,
      transporterOptions: { timeout: REQUEST_TIMEOUT_MS },
    });

  return {
    provider: calendarProvider.Google,

    grantsCalendarScope: (scope) => scope.split(/\s+/).includes(GOOGLE_SCOPE),

    consentUrl: (state) =>
      client().generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [GOOGLE_SCOPE],
        state,
      }),

    exchangeCode: async (code) => {
      let tokens;
      try {
        ({ tokens } = await client().getToken(code));
      } catch (error) {
        throw tokenError(error);
      }
      if (!tokens.access_token || !tokens.refresh_token) {
        throw new ProviderTokenError("missing_tokens");
      }
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scope: tokens.scope ?? "",
      };
    },

    accessToken: async (stored) => {
      const oauth = client();
      oauth.setCredentials({
        refresh_token: stored.refreshToken,
        // Without an expiry the library would trust the token forever.
        access_token: stored.expiresAt ? stored.accessToken : null,
        expiry_date: stored.expiresAt?.getTime() ?? null,
      });
      let token: string | null | undefined;
      try {
        ({ token } = await oauth.getAccessToken());
      } catch (error) {
        if (providerError(error) === "invalid_grant") {
          throw new ProviderGrantRevokedError("invalid_grant");
        }
        throw tokenError(error);
      }
      if (!token) throw new ProviderTokenError("missing_tokens");
      const expiry = oauth.credentials.expiry_date;
      return {
        accessToken: token,
        expiresAt: expiry ? new Date(expiry) : null,
        refreshToken: stored.refreshToken,
        refreshed: token !== stored.accessToken,
      };
    },

    revoke: async (refreshToken) => {
      try {
        await client().revokeToken(refreshToken);
      } catch (error) {
        throw tokenError(error);
      }
    },
  };
};
