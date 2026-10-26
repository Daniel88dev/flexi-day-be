import { Cron } from "croner";
import { directoryPermissionRow as R } from "../../db/schema/directory-schema.js";
import { retentionPeriod as P } from "../../db/schema/directory-retention-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import { SECTION_ROWS, type SectionRow } from "./permissionResolver.js";

export const RETENTION_PERIODS = [
  P.AtEnd,
  P.Days30,
  P.Months6,
  P.Year1,
  P.Years3,
  P.Years5,
  P.Years10,
  P.UntilErased,
] as const;

/** The product's Retention periods, for every organization that never changed one. */
export const RETENTION_DEFAULTS: Record<SectionRow, P> = {
  [R.Card]: P.UntilErased,
  [R.Photo]: P.Year1,
  [R.WorkContact]: P.Days30,
  [R.Job]: P.UntilErased,
  [R.Contact]: P.Days30,
  [R.Personal]: P.Years3,
};

export const isShortening = (from: P, to: P): boolean =>
  RETENTION_PERIODS.indexOf(to) < RETENTION_PERIODS.indexOf(from);

export const withDefaultPeriods = (stored: { section: R; period: P }[]): Record<SectionRow, P> => {
  const periods = { ...RETENTION_DEFAULTS };
  for (const row of stored) {
    const section = SECTION_ROWS.find((candidate) => candidate === row.section);
    if (section) periods[section] = row.period;
  }
  return periods;
};

const LABELS: Record<appLanguage, Record<P, string>> = {
  [appLanguage.English]: {
    [P.AtEnd]: "no time",
    [P.Days30]: "30 days",
    [P.Months6]: "6 months",
    [P.Year1]: "1 year",
    [P.Years3]: "3 years",
    [P.Years5]: "5 years",
    [P.Years10]: "10 years",
    [P.UntilErased]: "as long as your record is kept",
  },
  [appLanguage.Czech]: {
    [P.AtEnd]: "ani den",
    [P.Days30]: "30 dní",
    [P.Months6]: "6 měsíců",
    [P.Year1]: "1 rok",
    [P.Years3]: "3 roky",
    [P.Years5]: "5 let",
    [P.Years10]: "10 let",
    [P.UntilErased]: "tak dlouho, jak je uchován váš záznam",
  },
};

/** A period as the Art. 14 notice's `{period}` reads it. */
export const retentionPeriodLabel = (period: P, language: appLanguage): string =>
  LABELS[language][period];

/**
 * The day, in the nightly tick's zone, of the first nightly run at or after a
 * Section falls due, never earlier than the next run: the run that empties it.
 */
export const removalDay = (
  dueAt: Date,
  now: Date,
  nightly: { cron: string; timezone: string }
): string => {
  const from = new Date(Math.max(dueAt.getTime() - 1, now.getTime()));
  const run = new Cron(nightly.cron, { timezone: nightly.timezone, paused: true }).nextRun(from);
  return dayIn(run ?? from, nightly.timezone);
};

/** `YYYY-MM-DD` of an instant in a time zone. */
export const dayIn = (at: Date, timezone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
