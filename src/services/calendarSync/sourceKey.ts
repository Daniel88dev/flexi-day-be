import { calendarProvider } from "../../db/schema/calendar-connection-schema.js";
import { graphBirthdaySeries } from "./birthdaySeries.js";
import type { CalendarFeedRecord } from "./types.js";

/** The ledger columns naming the record a synced event stands for. */
export type LedgerSource = {
  sourceKey: string;
  vacationId: string | null;
  groupEventId: string | null;
  birthdayUserId: string | null;
};

/** One provider event a record writes; `segment` tells apart several from one record. */
export type SyncSource = LedgerSource & { segment: number | null };

export const vacationSourceKey = (vacationId: string): string => `v:${vacationId}`;

export const groupEventSourceKey = (groupEventId: string): string => `ge:${groupEventId}`;

export const birthdaySourceKey = (userId: string, segment: number | null = null): string =>
  segment === null ? `bd:${userId}` : `bd:${userId}:${segment.toString()}`;

const vacationSources = (record: CalendarFeedRecord & { kind: "vacation" }): SyncSource[] => [
  {
    sourceKey: vacationSourceKey(record.id),
    vacationId: record.id,
    groupEventId: null,
    birthdayUserId: null,
    segment: null,
  },
];

const birthdaySources = (
  record: CalendarFeedRecord & { kind: "birthday" },
  provider: calendarProvider
): SyncSource[] => {
  const segments =
    provider === calendarProvider.Microsoft
      ? graphBirthdaySeries(record).map((series) => series.segment)
      : [null];
  return segments.map((segment) => ({
    sourceKey: birthdaySourceKey(record.userId, segment),
    vacationId: null,
    groupEventId: null,
    birthdayUserId: record.userId,
    segment,
  }));
};

const groupEventSources = (record: CalendarFeedRecord & { kind: "groupEvent" }): SyncSource[] => [
  {
    sourceKey: groupEventSourceKey(record.id),
    vacationId: null,
    groupEventId: record.id,
    birthdayUserId: null,
    segment: null,
  },
];

/** The provider events a record stands for on one provider, each with its ledger key. */
export const syncSourcesOf = (
  record: CalendarFeedRecord,
  provider: calendarProvider
): SyncSource[] => {
  switch (record.kind) {
    case "birthday":
      return birthdaySources(record, provider);
    case "groupEvent":
      return groupEventSources(record);
    default:
      return vacationSources(record);
  }
};
