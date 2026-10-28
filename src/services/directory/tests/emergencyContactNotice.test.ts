import { describe, it, expect } from "vitest";
import { appLanguage } from "../../../db/schema/user-settings-schema.js";
import { DEFAULT_EMERGENCY_CONTACT_NOTICE, renderNotice } from "../emergencyContactNotice.js";
import { RETENTION_PERIODS, retentionPeriodLabel } from "../retentionPeriods.js";

describe("the Art. 14 emergency-contact notice", () => {
  it("fills every placeholder", () => {
    expect(
      renderNotice("{organization} keeps them. Ask {organization}. Kept {period}.", {
        organization: "Acme",
        period: "30 days",
      })
    ).toBe("Acme keeps them. Ask Acme. Kept 30 days.");
  });

  it("ships a default in English and Czech that names the organization and any period", () => {
    for (const language of [appLanguage.English, appLanguage.Czech]) {
      for (const period of RETENTION_PERIODS) {
        const text = renderNotice(DEFAULT_EMERGENCY_CONTACT_NOTICE[language], {
          organization: "Acme",
          period: retentionPeriodLabel(period, language),
        });
        expect(text).toContain("Acme");
        expect(text).not.toMatch(/[{}]/);
      }
    }
  });

  it("gives each emergency contact what Art. 14 GDPR asks for", () => {
    const expected: Record<appLanguage, RegExp[]> = {
      [appLanguage.English]: [
        /name and phone number/,
        /only to reach/,
        /Art\. 6\(1\)\(f\) GDPR/,
        /Flexi Day stores them for \{organization\}/,
        /for \{period\} after you leave/,
        /come from you/,
        /see, correct, delete or restrict/,
        /To reach \{organization\}, ask the person who added you/,
        /object/,
        /data protection authority/,
        /show this notice/,
      ],
      [appLanguage.Czech]: [
        /jméno a telefonní číslo/,
        /jen k tomu/,
        /čl\. 6 odst\. 1 písm\. f\) GDPR/,
        /Flexi Day je pro organizaci \{organization\} ukládá/,
        /\{period\} po vašem odchodu/,
        /pocházejí od vás/,
        /přístup.*opravu, výmaz nebo omezení zpracování/,
        /vám dá kontakt ten, kdo vás uvedl/,
        /námitku/,
        /dozorového úřadu/,
        /ukažte/i,
      ],
    };
    for (const language of [appLanguage.English, appLanguage.Czech]) {
      const text = DEFAULT_EMERGENCY_CONTACT_NOTICE[language];
      for (const pattern of expected[language]) expect(text).toMatch(pattern);
      expect(text.length).toBeLessThanOrEqual(2000);
    }
  });
});
