import { config } from "../../../config.js";
import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import { createFakeAdapter } from "./fake.js";
import { createGoogleAdapter } from "./google.js";
import { createMicrosoftAdapter } from "./microsoft.js";
import type { CalendarProviderAdapter } from "./types.js";

export const providerSlug = (provider: calendarProvider): "google" | "microsoft" =>
  provider === calendarProvider.Google ? "google" : "microsoft";

export const callbackUrl = (apiUrl: string, provider: calendarProvider): string =>
  `${apiUrl}/api/calendar-sync/connections/${providerSlug(provider)}/callback`;

/** The adapter for a provider whose switch is on, or `undefined` when it is off. */
export const providerAdapter = (
  provider: calendarProvider
): CalendarProviderAdapter | undefined => {
  const sync = config.calendarSync;
  const credentials = provider === calendarProvider.Google ? sync?.google : sync?.microsoft;
  if (!sync || !credentials) return undefined;

  const redirectUri = callbackUrl(sync.apiUrl, provider);
  if (sync.driver === "fake") return createFakeAdapter(provider, redirectUri);

  const options = { ...credentials, redirectUri };
  return provider === calendarProvider.Google
    ? createGoogleAdapter(options)
    : createMicrosoftAdapter(options);
};
