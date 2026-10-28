import { and, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import {
  directoryPermissionCells,
  organizationDirectorySettings,
} from "../../db/schema/directory-schema.js";
import { directoryDepartments, directoryLocations } from "../../db/schema/directory-list-schema.js";
import { directoryPhotos } from "../../db/schema/directory-photo-schema.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import {
  directoryRetentionHolds,
  directoryRetentionPeriods,
} from "../../db/schema/directory-retention-schema.js";
import {
  directoryPermissionHistory,
  directoryRoleAssignments,
} from "../../db/schema/directory-role-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { personExports, personExportScope } from "../../db/schema/person-export-schema.js";
import { logger } from "../../middleware/logger.js";
import { refuse } from "../../utils/appError.js";
import { sameName } from "../employment/eraseEmploymentServices.js";
import { lockOrganization } from "../organization/organizationServices.js";
import { organizationDataStore } from "../organizationData/organizationDataStore.js";
import { removeExportRows } from "../personExport/personExportBuild.js";
import { removePhotoObjects } from "./directoryPhotoServices.js";
import { organizationPhotosPrefix } from "./photoPrefixes.js";
import { getDirectorySettings } from "./directorySettings.js";

export type DeletedDirectoryData = {
  organizationId: string;
  exportKeys: string[];
  accountlessEmployments: number;
};

/**
 * Delete all directory data: the owner's act while the directory is off,
 * confirmed with the organization's name typed. It removes every Profile field
 * and sealed Section, the photo rows, the Department and Location lists, the
 * Directory roles, the Permission table and its history, the retention
 * settings and holds, the organization's own notice text, every Person export,
 * and every account-less Employment, open or ended. Organization exports stay:
 * they are the owner's return copy and expire on their own. Employments with an account
 * keep their copy, type and dates; the agreement acceptances, the Read log and
 * profile history entries of those Employments stay. The caller checks the
 * owner and deletes the stored objects after the commit with
 * {@link removeDeletedDirectoryObjects}.
 */
export const deleteAllDirectoryData = async (
  input: { organizationId: string; organizationName: string; confirmName: string; userId: string },
  tx: DbTransaction
): Promise<DeletedDirectoryData> => {
  const { organizationId, userId } = input;
  const context = { organizationId, userId };
  await lockOrganization(organizationId, tx);

  if ((await getDirectorySettings(organizationId, tx))?.enabled) {
    throw refuse(409, "DIRECTORY_ON", "Turn the directory off before deleting its data", context);
  }
  if (!sameName(input.confirmName, input.organizationName)) {
    throw refuse(422, "NAME_MISMATCH", "The typed name does not match the organization", context);
  }

  const exportKeys = await removeExportRows(
    organizationId,
    eq(personExports.scope, personExportScope.Person),
    tx
  );

  // Profiles first: they point at the two lists with no ON DELETE.
  await tx.delete(directoryProfiles).where(eq(directoryProfiles.organizationId, organizationId));
  await tx
    .delete(directorySensitiveProfiles)
    .where(eq(directorySensitiveProfiles.organizationId, organizationId));
  await tx.delete(directoryPhotos).where(eq(directoryPhotos.organizationId, organizationId));
  await tx
    .delete(directoryDepartments)
    .where(eq(directoryDepartments.organizationId, organizationId));
  await tx.delete(directoryLocations).where(eq(directoryLocations.organizationId, organizationId));
  await tx
    .delete(directoryRoleAssignments)
    .where(eq(directoryRoleAssignments.organizationId, organizationId));
  await tx
    .delete(directoryPermissionCells)
    .where(eq(directoryPermissionCells.organizationId, organizationId));
  await tx
    .delete(directoryPermissionHistory)
    .where(eq(directoryPermissionHistory.organizationId, organizationId));
  await tx
    .delete(directoryRetentionPeriods)
    .where(eq(directoryRetentionPeriods.organizationId, organizationId));
  await tx
    .delete(directoryRetentionHolds)
    .where(eq(directoryRetentionHolds.organizationId, organizationId));

  // Their invites, profile history and anything else keyed on them cascade.
  const accountless = await tx
    .delete(employments)
    .where(and(eq(employments.organizationId, organizationId), isNull(employments.userId)))
    .returning({ id: employments.id });

  await tx
    .update(organizationDirectorySettings)
    .set({
      emergencyContactNoticeEn: null,
      emergencyContactNoticeCs: null,
      checklistHiddenAt: null,
      dataDeletedAt: new Date(),
      dataDeletedByUserId: userId,
    })
    .where(eq(organizationDirectorySettings.organizationId, organizationId));

  return {
    organizationId,
    exportKeys,
    accountlessEmployments: accountless.length,
  };
};

/** After the commit: the rows are gone, so no sweep would ever find these files. */
export const removeDeletedDirectoryObjects = async (deleted: DeletedDirectoryData) => {
  await removePhotoObjects([organizationPhotosPrefix(deleted.organizationId)]);
  for (const key of deleted.exportKeys) {
    try {
      await organizationDataStore?.deleteObject(key);
    } catch (error) {
      logger.error("directory_delete_all.export_object_failed", {
        organizationId: deleted.organizationId,
        key,
        error,
      });
    }
  }
};
