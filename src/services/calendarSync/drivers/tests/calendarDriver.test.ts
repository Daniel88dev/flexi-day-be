import { describe, it, expect, vi, beforeEach } from "vitest";

const { calendarSync } = vi.hoisted(() => ({
  calendarSync: { value: undefined as unknown },
}));

vi.mock("../../../../config.js", () => ({
  config: {
    get calendarSync() {
      return calendarSync.value;
    },
  },
}));

vi.mock("../../../../db/db.js", () => ({ db: {} }));

import { calendarProvider } from "../../../../db/schema/calendar-connection-schema.js";
import { calendarDriver } from "../index.js";

const credentials = { clientId: "id", clientSecret: "secret" };
const syncConfig = (driver: "live" | "fake", google = true) => ({
  googleEnabled: google,
  microsoftEnabled: true,
  driver,
  appUrl: "http://localhost:3000",
  apiUrl: "http://localhost:8080",
  google: google ? credentials : undefined,
  microsoft: credentials,
});

beforeEach(() => {
  calendarSync.value = undefined;
});

describe("calendarDriver", () => {
  it("has no driver while direct sync is off", () => {
    expect(calendarDriver(calendarProvider.Google)).toBeUndefined();
  });

  it("has no driver for a provider whose switch is off", () => {
    calendarSync.value = syncConfig("live", false);

    expect(calendarDriver(calendarProvider.Google)).toBeUndefined();
    expect(calendarDriver(calendarProvider.Microsoft)?.provider).toBe(calendarProvider.Microsoft);
  });

  it.each(["live", "fake"] as const)("hands out a %s driver for each provider", (driver) => {
    calendarSync.value = syncConfig(driver);

    expect(calendarDriver(calendarProvider.Google)?.provider).toBe(calendarProvider.Google);
    expect(calendarDriver(calendarProvider.Microsoft)?.provider).toBe(calendarProvider.Microsoft);
  });
});
