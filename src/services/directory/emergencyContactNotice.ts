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
 * whoever edits them. A placeholder until the owner's legal wording lands.
 */
export const DEFAULT_EMERGENCY_CONTACT_NOTICE: NoticeTexts = {
  [appLanguage.English]:
    "{organization} keeps the names and phone numbers of the emergency contacts you add here, " +
    "only to reach them if something happens to you at work. They are kept while you work here " +
    "and for {period} after you leave. Please tell the people you add that you gave their details " +
    "to {organization}.",
  [appLanguage.Czech]:
    "Organizace {organization} uchovává jména a telefonní čísla nouzových kontaktů, které zde " +
    "uvedete, jen proto, aby je mohla zastihnout, kdyby se vám v práci něco stalo. Uchovává je po " +
    "dobu vaší práce a {period} po vašem odchodu. Dejte prosím lidem, které uvedete, vědět, že jste " +
    "jejich údaje předali organizaci {organization}.",
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
