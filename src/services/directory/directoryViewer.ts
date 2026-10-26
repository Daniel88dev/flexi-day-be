import { and, eq, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { refuse } from "../../utils/appError.js";
import { filterGroupIdsByOrganization, getManagedGroupIdsForUser } from "../group/groupServices.js";
import { getMemberIdsExcludingManagers } from "../groupUser/groupAccess.js";
import { getAdminGroupIdsForUser } from "../groupUser/groupUserServices.js";
import { getOrganizationById } from "../organization/organizationServices.js";
import { readDirectoryRoles } from "./directoryRoleServices.js";
import { isDirectoryOrganization, readPermissionCells } from "./directorySettingsServices.js";
import {
  resolveAccess,
  type DirectoryAccess,
  type DirectoryRecord,
  type ViewerStanding,
} from "./permissionResolver.js";

export type DirectoryViewer = {
  organizationId: string;
  standing: ViewerStanding;
  /** The viewer's access to one record of this organization. No database read. */
  accessTo: (record: DirectoryRecord) => DirectoryAccess;
  /** Owner, Org admin and HR see the Former list. */
  formerList: boolean;
};

/** The owner, org admins and HR read the Permission table, its roles and its history. */
export const canReadPermissionTable = (viewer: DirectoryViewer) =>
  viewer.standing.owner ||
  viewer.standing.organizationAdmin ||
  viewer.standing.roles.includes("HR");

/** User ids the viewer reaches as a Group admin: the plain members of the groups they manage or hold admin access in. */
const readGroupAdminReach = async (
  viewerUserId: string,
  organizationId: string,
  tx?: DbTransaction
): Promise<Set<string>> => {
  const direct = [
    ...(await getAdminGroupIdsForUser(viewerUserId, tx)),
    ...(await getManagedGroupIdsForUser(viewerUserId, tx)),
  ];
  const groupIds = await filterGroupIdsByOrganization([...new Set(direct)], organizationId, tx);
  return new Set(await getMemberIdsExcludingManagers(groupIds, tx));
};

/**
 * Loads the viewer's standing in a Directory organization and its Permission
 * table once, so every record of a request resolves without another query.
 * 404 for an unknown organization, 409 `DIRECTORY_OFF` while the directory is
 * off, 403 `NOT_IN_DIRECTORY` for a viewer with no standing there. A lapsed
 * plan changes nothing here: reads keep working.
 */
export const loadDirectoryViewer = async (
  viewerUserId: string,
  organizationId: string,
  tx?: DbTransaction
): Promise<DirectoryViewer> => {
  const context = { viewerUserId, organizationId };
  const organization = await getOrganizationById(organizationId, tx);
  if (!organization) throw refuse(404, "ORGANIZATION_NOT_FOUND", "Organization not found", context);
  if (!(await isDirectoryOrganization(organizationId, tx))) {
    throw refuse(409, "DIRECTORY_OFF", "The directory is off in this organization", context);
  }

  const client = tx ?? db;
  const [grant] = await client
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(
      and(
        eq(organizationUsers.organizationId, organizationId),
        eq(organizationUsers.userId, viewerUserId),
        isNull(organizationUsers.deletedAt)
      )
    )
    .limit(1);
  const [employment] = await client
    .select({ id: employments.id, type: employments.type })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        eq(employments.userId, viewerUserId),
        isNull(employments.endedAt)
      )
    )
    .limit(1);

  const owner = organization.ownerUserId === viewerUserId;
  const standing: ViewerStanding = {
    userId: viewerUserId,
    owner,
    organizationAdmin: !owner && grant !== undefined,
    employmentType: employment?.type ?? null,
    roles: employment
      ? ((await readDirectoryRoles([employment.id], tx)).get(employment.id) ?? [])
      : [],
    groupAdminReach: await readGroupAdminReach(viewerUserId, organizationId, tx),
  };

  if (!standing.owner && !standing.organizationAdmin && standing.employmentType === null) {
    throw refuse(403, "NOT_IN_DIRECTORY", "You are not one of this organization's people", context);
  }

  const cells = await readPermissionCells(organizationId, tx);
  return {
    organizationId,
    standing,
    accessTo: (record) => resolveAccess(cells, standing, record),
    formerList: standing.owner || standing.organizationAdmin || standing.roles.includes("HR"),
  };
};
