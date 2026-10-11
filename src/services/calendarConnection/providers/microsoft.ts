import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import {
  ProviderGrantRevokedError,
  ProviderTokenError,
  REFRESH_SKEW_MS,
  type CalendarProviderAdapter,
  type OAuthClientOptions,
  type ProviderTokens,
} from "./types.js";

export const MICROSOFT_SCOPE = "Calendars.ReadWrite offline_access";

const COMMON_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const REQUEST_TIMEOUT_MS = 10_000;

// Both mean only a new consent round helps: expired, revoked or idle-lapsed
// tokens, a password reset by an admin, MFA or consent the user must redo.
const REVOKED_ERRORS = new Set(["invalid_grant", "interaction_required"]);

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

export const createMicrosoftAdapter = (
  options: OAuthClientOptions & { authority?: string }
): CalendarProviderAdapter => {
  const authority = options.authority ?? COMMON_AUTHORITY;

  const postToken = async (form: Record<string, string>): Promise<TokenResponse> => {
    let response: Response;
    try {
      response = await fetch(`${authority}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          ...form,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderTokenError(error instanceof Error ? error.name : "network");
    }
    const body = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok) {
      const code = body.error ?? `http_${response.status}`;
      if (REVOKED_ERRORS.has(code)) throw new ProviderGrantRevokedError(code);
      throw new ProviderTokenError(code);
    }
    return body;
  };

  const expiresAt = (body: TokenResponse, now: number) =>
    typeof body.expires_in === "number" ? new Date(now + body.expires_in * 1000) : null;

  return {
    provider: calendarProvider.Microsoft,

    grantsCalendarScope: (scope) => /(^|[\s/])Calendars\.ReadWrite(\s|$)/i.test(scope),

    consentUrl: (state) => {
      const url = new URL(`${COMMON_AUTHORITY}/authorize`);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        response_type: "code",
        response_mode: "query",
        redirect_uri: options.redirectUri,
        scope: MICROSOFT_SCOPE,
        // Not `consent`: it demands a user consent that a tenant's policy may forbid even after
        // an admin consented for the tenant. Entra issues the refresh token either way.
        prompt: "select_account",
        state,
      }).toString();
      return url.toString();
    },

    exchangeCode: async (code): Promise<ProviderTokens> => {
      const now = Date.now();
      let body: TokenResponse;
      try {
        body = await postToken({
          grant_type: "authorization_code",
          code,
          redirect_uri: options.redirectUri,
          scope: MICROSOFT_SCOPE,
        });
      } catch (error) {
        if (error instanceof ProviderGrantRevokedError) throw new ProviderTokenError(error.reason);
        throw error;
      }
      if (!body.access_token || !body.refresh_token) {
        throw new ProviderTokenError("missing_tokens");
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: expiresAt(body, now),
        scope: body.scope ?? "",
      };
    },

    accessToken: async (stored, now = Date.now()) => {
      if (
        stored.accessToken &&
        stored.expiresAt &&
        stored.expiresAt.getTime() > now + REFRESH_SKEW_MS
      ) {
        return {
          accessToken: stored.accessToken,
          expiresAt: stored.expiresAt,
          refreshToken: stored.refreshToken,
          refreshed: false,
        };
      }
      const body = await postToken({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        scope: MICROSOFT_SCOPE,
      });
      if (!body.access_token) throw new ProviderTokenError("missing_tokens");
      return {
        accessToken: body.access_token,
        expiresAt: expiresAt(body, now),
        refreshToken: body.refresh_token ?? stored.refreshToken,
        refreshed: true,
      };
    },

    revoke: async () => {},
  };
};
