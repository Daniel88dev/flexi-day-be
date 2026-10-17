import type { CalendarFeedRecord } from "./types.js";

/** The ledger columns naming the record a synced event stands for. */
export type LedgerSource = {
  sourceKey: string;
  vacationId: string | null;
};

export const vacationSourceKey = (vacationId: string): string => `v:${vacationId}`;

export const ledgerSourceOf = (record: CalendarFeedRecord): LedgerSource => ({
  sourceKey: vacationSourceKey(record.id),
  vacationId: record.id,
});
