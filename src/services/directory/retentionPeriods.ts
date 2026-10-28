import { Cron } from "croner";
import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { retentionPeriod } from "../../db/schema/directory-retention-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import { SECTION_ROWS, type SectionRow } from "./permissionResolver.js";

export const RETENTION_PERIODS = [
  retentionPeriod.AtEnd,
  retentionPeriod.Days30,
  retentionPeriod.Months6,
  retentionPeriod.Year1,
  retentionPeriod.Years3,
  retentionPeriod.Years5,
  retentionPeriod.Years10,
  retentionPeriod.UntilErased,
] as const;

/** The product's Retention periods, for every organization that never changed one. */
export const RETENTION_DEFAULTS: Record<SectionRow, retentionPeriod> = {
  [directoryPermissionRow.Card]: retentionPeriod.UntilErased,
  [directoryPermissionRow.Photo]: retentionPeriod.Year1,
  [directoryPermissionRow.WorkContact]: retentionPeriod.Days30,
  [directoryPermissionRow.Job]: retentionPeriod.UntilErased,
  [directoryPermissionRow.Contact]: retentionPeriod.Days30,
  [directoryPermissionRow.Personal]: retentionPeriod.Years3,
};

export const isShortening = (from: retentionPeriod, to: retentionPeriod): boolean =>
  RETENTION_PERIODS.indexOf(to) < RETENTION_PERIODS.indexOf(from);

export const withDefaultPeriods = (
  stored: { section: directoryPermissionRow; period: retentionPeriod }[]
): Record<SectionRow, retentionPeriod> => {
  const periods = { ...RETENTION_DEFAULTS };
  for (const row of stored) {
    const section = SECTION_ROWS.find((candidate) => candidate === row.section);
    if (section) periods[section] = row.period;
  }
  return periods;
};

const LABELS: Record<appLanguage, Record<retentionPeriod, string>> = {
  [appLanguage.English]: {
    [retentionPeriod.AtEnd]: "0 days",
    [retentionPeriod.Days30]: "30 days",
    [retentionPeriod.Months6]: "6 months",
    [retentionPeriod.Year1]: "1 year",
    [retentionPeriod.Years3]: "3 years",
    [retentionPeriod.Years5]: "5 years",
    [retentionPeriod.Years10]: "10 years",
    [retentionPeriod.UntilErased]: "as long as their record is kept",
  },
  [appLanguage.Czech]: {
    [retentionPeriod.AtEnd]: "0 dní",
    [retentionPeriod.Days30]: "30 dní",
    [retentionPeriod.Months6]: "6 měsíců",
    [retentionPeriod.Year1]: "1 rok",
    [retentionPeriod.Years3]: "3 roky",
    [retentionPeriod.Years5]: "5 let",
    [retentionPeriod.Years10]: "10 let",
    [retentionPeriod.UntilErased]: "tak dlouho, jak je uchován záznam o tomto člověku",
  },
};

/** A period as the Art. 14 notice's `{period}` reads it. */
export const retentionPeriodLabel = (period: retentionPeriod, language: appLanguage): string =>
  LABELS[language][period];

export type NightlySchedule = { cron: string; timezone: string };

/**
 * The first nightly run after `after`. Callers pass `config.quotaRollover`:
 * the nightly tick that runs the purges shares the quota rollover's schedule.
 */
export const nightlyRunAfter = (after: Date, nightly: NightlySchedule): Date =>
  new Cron(nightly.cron, { timezone: nightly.timezone, paused: true }).nextRun(after) ?? after;

/**
 * The day, in the nightly tick's zone, of the first nightly run at or after a
 * Section falls due, never earlier than the next run: the run that empties it.
 */
export const removalDay = (dueAt: Date, now: Date, nightly: NightlySchedule): string => {
  const from = new Date(Math.max(dueAt.getTime() - 1, now.getTime()));
  return businessDateInZone(nightlyRunAfter(from, nightly), nightly.timezone);
};
