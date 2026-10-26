import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directoryDepartments, directoryLocations } from "../../db/schema/directory-list-schema.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import { directoryRole, directoryRoleAssignments } from "../../db/schema/directory-role-schema.js";
import { organizationDirectorySettings } from "../../db/schema/directory-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { canReadPermissionTable, type DirectoryViewer } from "./directoryViewer.js";
import { getDirectorySettings } from "./directorySettingsServices.js";

export type ChecklistItemKey = "departments" | "locations" | "hr" | "jobTitles";

export type DirectoryChecklist = {
  /** Hide was clicked since the latest enable, or every item this viewer sees is done. */
  hidden: boolean;
  items: { key: ChecklistItemKey; done: boolean }[];
  /** The owner's "Review who sees what" link to the Permission table. */
  reviewPermissions: boolean;
};

const assertChecklistViewer = (viewer: DirectoryViewer) => {
  if (!canReadPermissionTable(viewer)) {
    throw refuse(403, "CHECKLIST_DENIED", "Only the owner, org admins and HR see the checklist", {
      organizationId: viewer.organizationId,
    });
  }
};

const exists = async (query: Promise<unknown[]>) => (await query).length > 0;

const readTicks = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<Record<ChecklistItemKey, boolean>> => {
  const q = tx ?? db;
  const [departments, locations, hr, jobTitles] = await Promise.all([
    exists(
      q
        .select({ one: sql`1` })
        .from(directoryDepartments)
        .where(
          and(
            eq(directoryDepartments.organizationId, organizationId),
            isNull(directoryDepartments.archivedAt)
          )
        )
        .limit(1)
    ),
    exists(
      q
        .select({ one: sql`1` })
        .from(directoryLocations)
        .where(
          and(
            eq(directoryLocations.organizationId, organizationId),
            isNull(directoryLocations.archivedAt)
          )
        )
        .limit(1)
    ),
    exists(
      q
        .select({ one: sql`1` })
        .from(directoryRoleAssignments)
        .innerJoin(employments, eq(employments.id, directoryRoleAssignments.employmentId))
        .where(
          and(
            eq(directoryRoleAssignments.organizationId, organizationId),
            eq(directoryRoleAssignments.role, directoryRole.Hr),
            isNull(employments.endedAt),
            isNotNull(employments.userId),
            isNull(employments.accountDeletedAt)
          )
        )
        .limit(1)
    ),
    exists(
      q
        .select({ one: sql`1` })
        .from(directoryProfiles)
        .innerJoin(employments, eq(employments.id, directoryProfiles.employmentId))
        .where(
          and(
            eq(directoryProfiles.organizationId, organizationId),
            isNotNull(directoryProfiles.jobTitle),
            isNull(employments.endedAt)
          )
        )
        .limit(1)
    ),
  ]);
  return { departments, locations, hr, jobTitles };
};

/**
 * The setup checklist on the directory page, for the owner, org admins and HR.
 * Every tick is read from the data; assigning HR and the review link are the
 * owner's alone.
 */
export const readDirectoryChecklist = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<DirectoryChecklist> => {
  assertChecklistViewer(viewer);
  const owner = viewer.standing.owner;
  const settings = await getDirectorySettings(viewer.organizationId, tx);
  const ticks = await readTicks(viewer.organizationId, tx);

  const keys: ChecklistItemKey[] = owner
    ? ["departments", "locations", "hr", "jobTitles"]
    : ["departments", "locations", "jobTitles"];
  const items = keys.map((key) => ({ key, done: ticks[key] }));
  const hiddenByClick =
    settings?.checklistHiddenAt != null &&
    settings.enabledAt != null &&
    settings.checklistHiddenAt >= settings.enabledAt;

  return {
    hidden: hiddenByClick || items.every((item) => item.done),
    items,
    reviewPermissions: owner,
  };
};

/** Anyone who sees the checklist hides it for the organization until the next enable. Never plan-gated. */
export const hideDirectoryChecklist = async (
  viewer: DirectoryViewer,
  tx: DbTransaction
): Promise<DirectoryChecklist> => {
  assertChecklistViewer(viewer);
  await tx
    .update(organizationDirectorySettings)
    .set({ checklistHiddenAt: new Date() })
    .where(eq(organizationDirectorySettings.organizationId, viewer.organizationId));
  return readDirectoryChecklist(viewer, tx);
};
