import { and, eq, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directoryRole } from "../../db/schema/directory-role-schema.js";
import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import { refuse } from "../../utils/appError.js";
import { filterGroupIdsByOrganization, getManagedGroupIdsForUser } from "../group/groupServices.js";
import { getMemberIdsExcludingManagers } from "../groupUser/groupAccess.js";
import { getAdminGroupIdsForUser } from "../groupUser/groupUserServices.js";
import { getOrganizationById } from "../organization/organizationServices.js";
import { getUserLanguage } from "../userSettings/userSettingsServices.js";
import { readDirectoryRoles } from "./directoryRoleServices.js";
import { isDirectoryOrganization } from "./directorySettings.js";
import { readPermissionCells } from "./directorySettingsServices.js";
import {
  resolveAccess,
  type DirectoryAccess,
  type DirectoryRecord,
  type ViewerStanding,
} from "./permissionResolver.js";

export type DirectoryViewer = {
  organizationId: string;
  ownerUserId: string;
  standing: ViewerStanding;
  /** The viewer's access to one record of this organization. No database read. */
  accessTo: (record: DirectoryRecord) => DirectoryAccess;
  /** Country names and other server-made strings come in this language. */
  language: appLanguage;
};

/** The owner or an org admin. */
export const administersOrganization = (viewer: DirectoryViewer) =>
  viewer.standing.owner || viewer.standing.organizationAdmin;

/** The owner, an org admin or HR: the Former list, Directory settings and Profile history. */
export const administersPeople = (viewer: DirectoryViewer) =>
  administersOrganization(viewer) || viewer.standing.roles.includes(directoryRole.Hr);

/**
 * The audience whose Create account-less person cell lets the viewer add a
 * person, or null. The act resolves on the record it creates, open and without
 * an account, which no group admin reaches, so Group admin never credits.
 */
export const createPersonGrantor = (viewer: DirectoryViewer) =>
  viewer.accessTo({ userId: null, ended: false }).actGrantedBy[
    directoryPermissionRow.CreateAccountlessPerson
  ];

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

export type DirectoryViewerOptions = {
  language?: appLanguage;
  /** Let the owner and org admins through while the directory is off, without Directory roles. */
  whileOff?: boolean;
};

/**
 * Loads the viewer's standing in a Directory organization and its Permission
 * table once, so every record of a request resolves without another query.
 * 404 for an unknown organization, 409 `DIRECTORY_OFF` while the directory is
 * off (unless `whileOff` and the viewer administers the organization), 403
 * `NOT_IN_DIRECTORY` for a viewer with no standing there. A lapsed plan
 * changes nothing here: reads keep working. The language is the one the
 * request asks for, else the viewer's stored setting, else English.
 */
export const loadDirectoryViewer = async (
  viewerUserId: string,
  organizationId: string,
  tx?: DbTransaction,
  options: DirectoryViewerOptions = {}
): Promise<DirectoryViewer> => {
  const context = { viewerUserId, organizationId };
  const organization = await getOrganizationById(organizationId, tx);
  if (!organization) throw refuse(404, "ORGANIZATION_NOT_FOUND", "Organization not found", context);
  const directoryOn = await isDirectoryOrganization(organizationId, tx);
  const directoryOff = () =>
    refuse(409, "DIRECTORY_OFF", "The directory is off in this organization", context);
  if (!directoryOn && !options.whileOff) throw directoryOff();

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
    roles:
      employment && directoryOn
        ? ((await readDirectoryRoles([employment.id], tx)).get(employment.id) ?? [])
        : [],
    groupAdminReach: await readGroupAdminReach(viewerUserId, organizationId, tx),
  };

  if (!directoryOn && !standing.owner && !standing.organizationAdmin) throw directoryOff();
  if (!standing.owner && !standing.organizationAdmin && standing.employmentType === null) {
    throw refuse(403, "NOT_IN_DIRECTORY", "You are not one of this organization's people", context);
  }

  const cells = await readPermissionCells(organizationId, tx);
  return {
    organizationId,
    ownerUserId: organization.ownerUserId,
    standing,
    accessTo: (record) => resolveAccess(cells, standing, record),
    language: options.language ?? (await getUserLanguage(viewerUserId, tx)) ?? appLanguage.English,
  };
};

/**
 * One record of the viewer's organization with the viewer's access to it,
 * locked `FOR UPDATE` unless `lock` is false. 404 `PERSON_NOT_FOUND` when it
 * is in another organization or out of reach, so the two look the same.
 */
export const lockRecordInReach = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx: DbTransaction,
  { lock = true }: { lock?: boolean } = {}
) => {
  const context = {
    organizationId: viewer.organizationId,
    employmentId,
    viewerUserId: viewer.standing.userId,
  };
  const query = tx
    .select({
      id: employments.id,
      userId: employments.userId,
      type: employments.type,
      name: employments.name,
      email: employments.email,
      startedAt: employments.startedAt,
      endedAt: employments.endedAt,
      accountDeletedAt: employments.accountDeletedAt,
    })
    .from(employments)
    .where(
      and(eq(employments.organizationId, viewer.organizationId), eq(employments.id, employmentId))
    );
  const [record] = lock ? await query.for("update") : await query;
  const access =
    record && viewer.accessTo({ userId: record.userId, ended: record.endedAt !== null });
  if (!record || !access?.inReach) {
    throw refuse(404, "PERSON_NOT_FOUND", "Person not found", context);
  }
  return { record, access, context };
};
