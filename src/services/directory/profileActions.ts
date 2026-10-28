import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { administersOrganization, type DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryAccess } from "./permissionResolver.js";
import type { ProfileActions } from "./types.js";

export const profileActions = (
  viewer: DirectoryViewer,
  record: {
    userId: string | null;
    endedAt: Date | null;
    accountDeletedAt: Date | null;
  },
  access: DirectoryAccess,
  copyFromPreviousSpell = false
): ProfileActions => ({
  end:
    record.endedAt === null &&
    record.userId !== viewer.ownerUserId &&
    access.acts[directoryPermissionRow.EndEmployment],
  export: administersOrganization(viewer),
  erase:
    administersOrganization(viewer) && (record.userId === null || record.accountDeletedAt !== null),
  hold: administersOrganization(viewer) && record.endedAt !== null,
  invite:
    record.userId === null &&
    record.endedAt === null &&
    access.acts[directoryPermissionRow.SendDirectoryInvite],
  changeType: record.endedAt === null && access.acts[directoryPermissionRow.ChangeWorkerType],
  copyFromPreviousSpell,
});
