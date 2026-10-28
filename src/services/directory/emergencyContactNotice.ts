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
 * The product's default Art. 14 notice, shown under the emergency contacts for
 * whoever edits them to pass on, so it speaks to the emergency contact. Keep it in step with section 6 of the web's
 * `/directory-agreement/` page.
 */
export const DEFAULT_EMERGENCY_CONTACT_NOTICE: NoticeTexts = {
  [appLanguage.English]:
    "{organization} keeps your name and phone number because one of its people gave them as " +
    "their emergency contact. It uses them only to reach you if something happens to that " +
    "person at work, in its legitimate interest in being able to do so (Art. 6(1)(f) GDPR). " +
    "Flexi Day stores them for {organization}, encrypted, in the EU, and only the people " +
    "{organization} allows to see private contact details can see them. They are kept while " +
    "that person works there and for {period} after they leave. You can ask {organization} to " +
    "see, correct, delete or restrict your details, object to their use, and complain to a " +
    "data protection authority. The person who gave your details can tell you how to reach " +
    "{organization}.",
  [appLanguage.Czech]:
    "Organizace {organization} uchovává vaše jméno a telefonní číslo, protože vás jeden z " +
    "jejích lidí uvedl jako svůj nouzový kontakt. Používá je jen k tomu, aby vás zastihla, " +
    "kdyby se tomuto člověku v práci něco stalo, a to na základě svého oprávněného zájmu (čl. 6 " +
    "odst. 1 písm. f) GDPR). Flexi Day je pro organizaci {organization} ukládá šifrovaně v EU a " +
    "vidí je jen ti, komu organizace {organization} dovolí vidět soukromé kontaktní údaje. " +
    "Uchovávají se po dobu, kdy tento člověk v organizaci pracuje, a {period} poté, co odejde. " +
    "Můžete organizaci {organization} požádat o přístup ke svým údajům, jejich opravu, výmaz " +
    "nebo omezení zpracování, vznést námitku proti jejich použití a podat stížnost u " +
    "dozorového úřadu. Kontakt na organizaci {organization} vám dá ten, kdo vás uvedl.",
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
