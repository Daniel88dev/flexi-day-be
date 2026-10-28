import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { organizationDirectorySettings } from "../../db/schema/directory-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import { refuse } from "../../utils/appError.js";
import {
  administersOrganization,
  administersPeople,
  type DirectoryViewer,
} from "./directoryViewer.js";
import type { DirectoryGeneralSettings, PutDirectoryGeneralSettings } from "./types.js";
import {
  contactRetentionLabels,
  DEFAULT_EMERGENCY_CONTACT_NOTICE,
  readStoredNotice,
} from "./emergencyContactNotice.js";

/** The General tab of Directory settings: the Emergency contact notice texts. */
export const readGeneralSettings = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<DirectoryGeneralSettings> => {
  if (!administersPeople(viewer)) {
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
  const period = await contactRetentionLabels(viewer.organizationId, tx);
  return {
    editable: administersOrganization(viewer),
    emergencyContactNotice: { en: stored[appLanguage.English], cs: stored[appLanguage.Czech] },
    defaults: {
      en: DEFAULT_EMERGENCY_CONTACT_NOTICE[appLanguage.English],
      cs: DEFAULT_EMERGENCY_CONTACT_NOTICE[appLanguage.Czech],
    },
    period: { en: period[appLanguage.English], cs: period[appLanguage.Czech] },
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
  if (!administersOrganization(viewer)) {
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
