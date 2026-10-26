import { describe, it, expect } from "vitest";
import { directoryPermissionRow as R } from "../../../db/schema/directory-schema.js";
import { retentionPeriod as P } from "../../../db/schema/directory-retention-schema.js";
import { appLanguage } from "../../../db/schema/user-settings-schema.js";
import {
  RETENTION_DEFAULTS,
  RETENTION_PERIODS,
  isShortening,
  removalDay,
  retentionPeriodLabel,
  withDefaultPeriods,
} from "../retentionPeriods.js";

describe("retention periods", () => {
  it("defaults to the decided periods per Section", () => {
    expect(RETENTION_DEFAULTS).toEqual({
      [R.Card]: P.UntilErased,
      [R.Job]: P.UntilErased,
      [R.WorkContact]: P.Days30,
      [R.Contact]: P.Days30,
      [R.Personal]: P.Years3,
      [R.Photo]: P.Year1,
    });
  });

  it("offers one list, from at end to until erased", () => {
    expect(RETENTION_PERIODS).toEqual([
      "AT_END",
      "DAYS_30",
      "MONTHS_6",
      "YEAR_1",
      "YEARS_3",
      "YEARS_5",
      "YEARS_10",
      "UNTIL_ERASED",
    ]);
  });

  it("counts a move to an earlier period as shortening, and nothing else", () => {
    expect(isShortening(P.Years3, P.Days30)).toBe(true);
    expect(isShortening(P.UntilErased, P.Years10)).toBe(true);
    expect(isShortening(P.Days30, P.AtEnd)).toBe(true);
    expect(isShortening(P.Days30, P.Days30)).toBe(false);
    expect(isShortening(P.Days30, P.UntilErased)).toBe(false);
  });

  it("fills Sections the organization never set with the default", () => {
    expect(withDefaultPeriods([{ section: R.Contact, period: P.AtEnd }])).toEqual({
      ...RETENTION_DEFAULTS,
      [R.Contact]: P.AtEnd,
    });
  });

  it("names every period for the notice in English and Czech", () => {
    expect(retentionPeriodLabel(P.Days30, appLanguage.English)).toBe("30 days");
    expect(retentionPeriodLabel(P.Days30, appLanguage.Czech)).toBe("30 dní");
    expect(retentionPeriodLabel(P.Years3, appLanguage.Czech)).toBe("3 roky");
    expect(retentionPeriodLabel(P.Years5, appLanguage.Czech)).toBe("5 let");
    for (const period of RETENTION_PERIODS) {
      for (const language of [appLanguage.English, appLanguage.Czech]) {
        expect(retentionPeriodLabel(period, language)).toMatch(/\S/);
      }
    }
  });
});

describe("removalDay", () => {
  const nightly = { cron: "0 2 * * *", timezone: "Europe/Prague" };
  const now = new Date("2026-10-26T12:00:00Z");
  const day = (dueAt: string) => removalDay(new Date(dueAt), now, nightly);

  it("is the day of the first nightly run at or after the Section falls due", () => {
    expect(day("2026-11-24T01:00:00Z")).toBe("2026-11-24");
    expect(day("2026-11-24T01:00:01Z")).toBe("2026-11-25");
    expect(day("2026-11-23T10:00:00Z")).toBe("2026-11-24");
    expect(day("2026-11-23T23:30:00Z")).toBe("2026-11-24");
  });

  it("follows Prague's summer time", () => {
    expect(day("2027-07-01T00:00:00Z")).toBe("2027-07-01");
    expect(day("2027-07-01T00:00:01Z")).toBe("2027-07-02");
  });

  it("is never earlier than the next run, so a Section already past due goes tonight", () => {
    expect(day("2026-01-01T00:00:00Z")).toBe("2026-10-27");
  });
});
