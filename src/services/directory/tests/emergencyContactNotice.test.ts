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

  it("speaks to the emergency contact with what Art. 14 GDPR asks for", () => {
    const expected: Record<appLanguage, RegExp[]> = {
      [appLanguage.English]: [
        /keeps your name and phone number/,
        /gave them as their emergency contact/,
        /only to reach you/,
        /Art\. 6\(1\)\(f\) GDPR/,
        /Flexi Day stores them for \{organization\}/,
        /for \{period\} after they leave/,
        /see, correct, delete or restrict your details/,
        /object/,
        /data protection authority/,
        /can tell you how to reach \{organization\}/,
      ],
      [appLanguage.Czech]: [
        /uchovává vaše jméno a telefonní číslo/,
        /uvedl jako svůj nouzový kontakt/,
        /aby vás zastihla/,
        /čl\. 6 odst\. 1 písm\. f\) GDPR/,
        /Flexi Day je pro organizaci \{organization\} ukládá/,
        /\{period\} poté, co odejde/,
        /přístup.*opravu, výmaz nebo omezení zpracování/,
        /námitku/,
        /dozorového úřadu/,
        /vám dá ten, kdo vás uvedl/,
      ],
    };
    for (const language of [appLanguage.English, appLanguage.Czech]) {
      const text = DEFAULT_EMERGENCY_CONTACT_NOTICE[language];
      for (const pattern of expected[language]) expect(text).toMatch(pattern);
      expect(text.length).toBeLessThanOrEqual(2000);
    }
  });
});
