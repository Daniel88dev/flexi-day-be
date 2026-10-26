import { describe, it, expect } from "vitest";
import { appLanguage } from "../../../db/schema/user-settings-schema.js";
import {
  DEFAULT_EMERGENCY_CONTACT_NOTICE,
  contactRetentionLabel,
  renderNotice,
} from "../emergencyContactNotice.js";

describe("the Art. 14 emergency-contact notice", () => {
  it("fills every placeholder", () => {
    expect(
      renderNotice("{organization} keeps them. Ask {organization}. Kept {period}.", {
        organization: "Acme",
        period: "30 days",
      })
    ).toBe("Acme keeps them. Ask Acme. Kept 30 days.");
  });

  it("ships a default in English and Czech that names the organization and the period", () => {
    for (const language of [appLanguage.English, appLanguage.Czech]) {
      const text = renderNotice(DEFAULT_EMERGENCY_CONTACT_NOTICE[language], {
        organization: "Acme",
        period: contactRetentionLabel(language),
      });
      expect(text).toContain("Acme");
      expect(text).not.toMatch(/[{}]/);
    }
    expect(contactRetentionLabel(appLanguage.English)).toBe("30 days");
    expect(contactRetentionLabel(appLanguage.Czech)).toBe("30 dní");
  });
});
