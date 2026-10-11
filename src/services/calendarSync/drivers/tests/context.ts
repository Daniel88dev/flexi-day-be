import {
  calendarCapability,
  calendarConnectionStatus,
  calendarProvider,
} from "../../../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../../../db/schema/vacation-schema.js";
import type { CalendarConnectionRecord } from "../../../calendarConnection/types.js";
import { buildDesired, type DesiredEvent } from "../../eventBuilder.js";
import { recordTypeLabels } from "../../labels.js";
import type { AccessTokenSource, DriverContext } from "../types.js";

export const connection = (
  provider: calendarProvider,
  overrides: Partial<CalendarConnectionRecord> = {}
): CalendarConnectionRecord => ({
  id: "connection-1",
  userId: "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b",
  provider,
  refreshTokenEnc: "enc(refresh)",
  accessTokenEnc: "enc(access)",
  accessTokenExpiresAt: null,
  grantedScopes: "",
  capability: calendarCapability.Unknown,
  status: calendarConnectionStatus.Active,
  lastErrorAt: null,
  syncLeaseUntil: null,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** Hands out `token-1`, then `token-2` and so on after each forced refresh. */
export const countingTokens = () => {
  const calls: { forceRefresh: boolean }[] = [];
  let generation = 1;
  const source: AccessTokenSource = (options) => {
    calls.push({ forceRefresh: options?.forceRefresh ?? false });
    if (options?.forceRefresh) generation += 1;
    return Promise.resolve(`token-${generation}`);
  };
  return { source, calls };
};

export const context = (
  provider: calendarProvider,
  accessToken: AccessTokenSource = countingTokens().source
): DriverContext => ({ connection: connection(provider), accessToken });

export const desired = (
  provider: calendarProvider,
  capability: calendarCapability = calendarCapability.Unknown,
  vacationType: CalendarRecordType = CalendarRecordType.Vacation
): DesiredEvent =>
  buildDesired({
    record: {
      id: "vac-1",
      vacationType,
      requestedDay: "2026-10-12",
      startTime: null,
      endTime: null,
      note: null,
    },
    provider,
    capability,
    timeZone: "Europe/Prague",
    labels: recordTypeLabels("en"),
    configId: "cfg-1",
    ledgerId: "ledger-1",
  })!;
