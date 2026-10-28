import { eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import {
  directoryPermissionRow,
  organizationDirectorySettings,
} from "../../db/schema/directory-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import { readRetentionPeriods } from "./retentionPurge.js";
import { retentionPeriodLabel } from "./retentionPeriods.js";

export type NoticeTexts = Record<appLanguage, string>;

/**
 * The product's default Art. 14 notice, shown under the emergency contacts to
 * whoever edits them. Keep it in step with section 6 of the web's
 * `/directory-agreement/` page.
 */
export const DEFAULT_EMERGENCY_CONTACT_NOTICE: NoticeTexts = {
  [appLanguage.English]:
    "{organization} keeps the name and phone number of each emergency contact you add here, " +
    "only to reach them if something happens to you at work. It does so in its legitimate " +
    "interest in being able to reach them (Art. 6(1)(f) GDPR). Flexi Day stores them for " +
    "{organization}, encrypted, in the EU, and only the people {organization} allows to see " +
    "your private contact details can see them. They are kept while you work here and for " +
    "{period} after you leave. The details come from you. An emergency contact can ask " +
    "{organization} to see, correct, delete or restrict their details, can object to their " +
    "use, and can complain to a data protection authority. To reach {organization}, ask the " +
    "person who added you. Please show this notice to everyone you add.",
  [appLanguage.Czech]:
    "Organizace {organization} uchovává jméno a telefonní číslo každého nouzového kontaktu, " +
    "kterého zde uvedete, jen k tomu, aby ho zastihla, kdyby se vám v práci něco stalo. Činí " +
    "tak na základě svého oprávněného zájmu na tom, aby ho mohla zastihnout (čl. 6 odst. 1 " +
    "písm. f) GDPR). Flexi Day je pro organizaci {organization} ukládá šifrovaně v EU a vidí " +
    "je jen ti, komu organizace {organization} dovolí vidět vaše soukromé kontaktní údaje. " +
    "Uchovávají se po dobu, kdy zde pracujete, a {period} po vašem odchodu. Údaje pocházejí " +
    "od vás. Nouzový kontakt může organizaci {organization} požádat o přístup ke svým údajům, " +
    "jejich opravu, výmaz nebo omezení zpracování, může vznést námitku proti jejich použití a " +
    "podat stížnost u dozorového úřadu. Na organizaci {organization} vám dá kontakt ten, kdo " +
    "vás uvedl. Ukažte prosím toto upozornění každému, koho uvedete.",
};

/** How long the organization keeps Contact after an Employment ends, as the notice names it. */
export const contactRetentionLabels = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<Record<appLanguage, string>> => {
  const period = (await readRetentionPeriods(organizationId, tx))[directoryPermissionRow.Contact];
  return {
    [appLanguage.English]: retentionPeriodLabel(period, appLanguage.English),
    [appLanguage.Czech]: retentionPeriodLabel(period, appLanguage.Czech),
  };
};

export const renderNotice = (
  text: string,
  values: { organization: string; period: string }
): string =>
  text.replaceAll("{organization}", values.organization).replaceAll("{period}", values.period);

/** The organization's own notice texts; null in a language reads as the default. */
export const readStoredNotice = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<Record<appLanguage, string | null>> => {
  const [row] = await (tx ?? db)
    .select({
      en: organizationDirectorySettings.emergencyContactNoticeEn,
      cs: organizationDirectorySettings.emergencyContactNoticeCs,
    })
    .from(organizationDirectorySettings)
    .where(eq(organizationDirectorySettings.organizationId, organizationId));
  return {
    [appLanguage.English]: row?.en ?? null,
    [appLanguage.Czech]: row?.cs ?? null,
  };
};

/** The notice in one language with its placeholders filled. */
export const emergencyContactNotice = async (
  organization: { id: string; name: string },
  language: appLanguage,
  tx?: DbTransaction
): Promise<string> => {
  const stored = await readStoredNotice(organization.id, tx);
  return renderNotice(stored[language] ?? DEFAULT_EMERGENCY_CONTACT_NOTICE[language], {
    organization: organization.name,
    period: (await contactRetentionLabels(organization.id, tx))[language],
  });
};
