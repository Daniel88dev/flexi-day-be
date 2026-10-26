import { eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { organizationDirectorySettings } from "../../db/schema/directory-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import { refuse } from "../../utils/appError.js";
import { canReadPermissionTable, type DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryGeneralSettings, PutDirectoryGeneralSettings } from "./types.js";

export type NoticeTexts = Record<appLanguage, string>;

/**
 * The product's default Art. 14 notice, shown under the emergency contacts to
 * whoever edits them. A placeholder: the legal wording is the owner's (fenro
 * T-496), and the branch does not reach main before it.
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

/**
 * How long Contact is kept after an Employment ends, as the notice names it.
 * The product default until retention periods become editable (T-511).
 */
export const contactRetentionLabel = (language: appLanguage): string =>
  language === appLanguage.Czech ? "30 dní" : "30 days";

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
    period: contactRetentionLabel(language),
  });
};

/** The owner and org admins change the General settings; HR reads them. */
export const canEditGeneralSettings = (viewer: DirectoryViewer) =>
  viewer.standing.owner || viewer.standing.organizationAdmin;

export const readGeneralSettings = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<DirectoryGeneralSettings> => {
  if (!canReadPermissionTable(viewer)) {
    throw refuse(
      403,
      "SETTINGS_DENIED",
      "Only the owner, org admins and HR open Directory settings",
      {
        organizationId: viewer.organizationId,
        viewerUserId: viewer.standing.userId,
      }
    );
  }
  const stored = await readStoredNotice(viewer.organizationId, tx);
  return {
    editable: canEditGeneralSettings(viewer),
    emergencyContactNotice: { en: stored[appLanguage.English], cs: stored[appLanguage.Czech] },
    defaults: {
      en: DEFAULT_EMERGENCY_CONTACT_NOTICE[appLanguage.English],
      cs: DEFAULT_EMERGENCY_CONTACT_NOTICE[appLanguage.Czech],
    },
    period: {
      en: contactRetentionLabel(appLanguage.English),
      cs: contactRetentionLabel(appLanguage.Czech),
    },
  };
};

/**
 * Sets the organization's own notice texts; null goes back to the default.
 * A setting, like retention periods, so no plan gate.
 */
export const updateGeneralSettings = async (
  viewer: DirectoryViewer,
  body: PutDirectoryGeneralSettings,
  tx: DbTransaction
): Promise<DirectoryGeneralSettings> => {
  if (!canEditGeneralSettings(viewer)) {
    throw refuse(403, "SETTINGS_NOT_EDITABLE", "Only the owner and org admins change these", {
      organizationId: viewer.organizationId,
      viewerUserId: viewer.standing.userId,
    });
  }
  const { en, cs } = body.emergencyContactNotice;
  const set = {
    ...(en !== undefined && { emergencyContactNoticeEn: en }),
    ...(cs !== undefined && { emergencyContactNoticeCs: cs }),
  };
  if (Object.keys(set).length > 0) {
    await tx
      .update(organizationDirectorySettings)
      .set(set)
      .where(eq(organizationDirectorySettings.organizationId, viewer.organizationId));
  }
  return readGeneralSettings(viewer, tx);
};
