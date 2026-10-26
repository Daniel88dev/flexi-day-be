import { and, eq, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directoryPermissionRow as R } from "../../db/schema/directory-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import type { DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryAccess } from "./permissionResolver.js";
import type { ProfileActions } from "./types.js";

/** The owner and org admins: they see who is in no group, export and erase. */
export const administersOrganization = (viewer: DirectoryViewer) =>
  viewer.standing.owner || viewer.standing.organizationAdmin;

/** Account holders the organization links through a group: a live membership or a managed group. */
export const groupedUserIds = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<Set<string>> => {
  const client = tx ?? db;
  const members = await client
    .selectDistinct({ userId: groupUsers.userId })
    .from(groupUsers)
    .innerJoin(groups, eq(groups.id, groupUsers.groupId))
    .where(
      and(
        eq(groups.organizationId, organizationId),
        isNull(groups.deletedAt),
        isNull(groupUsers.deletedAt)
      )
    );
  const managers = await client
    .selectDistinct({ userId: groups.managerUserId })
    .from(groups)
    .where(and(eq(groups.organizationId, organizationId), isNull(groups.deletedAt)));
  return new Set([...members, ...managers].map((row) => row.userId));
};

export const profileActions = (
  viewer: DirectoryViewer,
  record: {
    userId: string | null;
    endedAt: Date | null;
    accountDeletedAt: Date | null;
  },
  access: DirectoryAccess
): ProfileActions => ({
  end:
    record.endedAt === null && record.userId !== viewer.ownerUserId && access.acts[R.EndEmployment],
  export: administersOrganization(viewer),
  erase:
    administersOrganization(viewer) && (record.userId === null || record.accountDeletedAt !== null),
  hold: administersOrganization(viewer) && record.endedAt !== null,
  invite: record.userId === null && record.endedAt === null && access.acts[R.SendDirectoryInvite],
  changeType: record.endedAt === null && access.acts[R.ChangeWorkerType],
});
