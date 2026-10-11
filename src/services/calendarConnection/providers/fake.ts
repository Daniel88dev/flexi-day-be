import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import { GOOGLE_SCOPE } from "./google.js";
import {
  ProviderGrantRevokedError,
  ProviderTokenError,
  REFRESH_SKEW_MS,
  type CalendarProviderAdapter,
} from "./types.js";

/** A stored refresh token containing this fails refresh with `invalid_grant`. */
export const FAKE_REVOKED_MARKER = "fake-revoked";
/** A callback code containing this fails the exchange. */
export const FAKE_EXCHANGE_FAILURE_MARKER = "fake-fail";
/** A callback code containing this comes back without the calendar scope. */
export const FAKE_NO_SCOPE_MARKER = "fake-noscope";

const fakeScope = (provider: calendarProvider) =>
  provider === calendarProvider.Google
    ? GOOGLE_SCOPE
    : "https://graph.microsoft.com/Calendars.ReadWrite";

const HOUR_MS = 60 * 60 * 1000;

/**
 * `CALENDAR_SYNC_DRIVER=fake`: never calls out. Consent goes straight back to
 * our own callback with code `fake-code`, and tokens are derived from the code,
 * so a code carrying a marker yields a connection that fails the way it names.
 */
export const createFakeAdapter = (
  provider: calendarProvider,
  callbackUrl: string
): CalendarProviderAdapter => ({
  provider,

  grantsCalendarScope: (scope) => scope === fakeScope(provider),

  consentUrl: (state) => {
    const url = new URL(callbackUrl);
    url.search = new URLSearchParams({ code: "fake-code", state }).toString();
    return url.toString();
  },

  exchangeCode: (code) => {
    if (code.includes(FAKE_EXCHANGE_FAILURE_MARKER)) {
      return Promise.reject(new ProviderTokenError("fake_exchange_failed"));
    }
    const slug = provider.toLowerCase();
    return Promise.resolve({
      accessToken: `fake-access-${slug}-${code}`,
      refreshToken: `fake-refresh-${slug}-${code}`,
      expiresAt: new Date(Date.now() + HOUR_MS),
      scope: code.includes(FAKE_NO_SCOPE_MARKER) ? "" : fakeScope(provider),
    });
  },

  accessToken: (stored, now = Date.now()) => {
    if (stored.refreshToken.includes(FAKE_REVOKED_MARKER)) {
      return Promise.reject(new ProviderGrantRevokedError("invalid_grant"));
    }
    if (
      stored.accessToken &&
      stored.expiresAt &&
      stored.expiresAt.getTime() > now + REFRESH_SKEW_MS
    ) {
      return Promise.resolve({
        accessToken: stored.accessToken,
        expiresAt: stored.expiresAt,
        refreshToken: stored.refreshToken,
        refreshed: false,
      });
    }
    return Promise.resolve({
      accessToken: `fake-access-${provider.toLowerCase()}-${now}`,
      expiresAt: new Date(now + HOUR_MS),
      refreshToken: stored.refreshToken,
      refreshed: true,
    });
  },

  revoke: async () => {},
});
