import { config } from "../../../config.js";
import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import { createFakeDriver, databaseFakeStore } from "./fakeDriver.js";
import { createGoogleDriver } from "./googleDriver.js";
import { createMicrosoftDriver } from "./microsoftDriver.js";
import type { CalendarDriver } from "./types.js";

/**
 * The event driver for a provider whose switch is on, or `undefined` when it
 * is off. Same switches as `providerAdapter`.
 */
export const calendarDriver = (provider: calendarProvider): CalendarDriver | undefined => {
  const sync = config.calendarSync;
  const credentials = provider === calendarProvider.Google ? sync?.google : sync?.microsoft;
  if (!sync || !credentials) return undefined;

  if (sync.driver === "fake") return createFakeDriver(provider, { store: databaseFakeStore() });
  return provider === calendarProvider.Google ? createGoogleDriver() : createMicrosoftDriver();
};
