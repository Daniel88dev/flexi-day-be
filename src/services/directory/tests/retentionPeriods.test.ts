import { describe, it, expect } from "vitest";
import { directoryPermissionRow as R } from "../../../db/schema/directory-schema.js";
import { retentionPeriod as P } from "../../../db/schema/directory-retention-schema.js";
import { appLanguage } from "../../../db/schema/user-settings-schema.js";
import {
  RETENTION_DEFAULTS,
  RETENTION_PERIODS,
  isShortening,
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
