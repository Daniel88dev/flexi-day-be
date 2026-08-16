import {
  getAdminGroupIdsForUser,
  getGroupUser,
} from "../../services/groupUser/groupUserServices.js";
import {
  filterGroupIdsByOrganization,
  getGroup,
  getLiveGroupIdsForOrganizations,
} from "../../services/group/groupServices.js";
import {
  getAdminOrganizationsForUser,
  isOrganizationAdmin,
} from "../../services/organization/organizationServices.js";
import type { DbTransaction } from "../../db/db.js";
import AppError from "../../utils/appError.js";

/**
 * True when the caller administers the organization that owns the group.
 *
 * Org admins are administrators *over* an org's groups without being members
 * of them, so this deliberately grants only administration — never approver
 * rights (deciding someone's leave is a workflow role held through group
 * membership) and never membership itself.
 */
const isOrganizationAdminForGroup = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const group = await getGroup(groupId, tx);
  if (!group) return false;
  return isOrganizationAdmin(userId, group.organizationId, tx);
};

export const validateUserGroupAccess = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const groupUser = await getGroupUser(userId, groupId, tx);
  if (groupUser?.viewAccess) return true;
  return isOrganizationAdminForGroup(userId, groupId, tx);
};

/**
 * Whether the caller may administer the group, and whether that authority came
 * from the organization rather than a membership — the UI surfaces the
 * difference so nobody edits another team believing they belong to it.
 */
export const resolveGroupAdmin = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<{ canAdmin: boolean; viaOrgAdmin: boolean }> => {
  const groupUser = await getGroupUser(userId, groupId, tx);
  if (groupUser?.adminAccess) return { canAdmin: true, viaOrgAdmin: false };

  const viaOrg = await isOrganizationAdminForGroup(userId, groupId, tx);
  return { canAdmin: viaOrg, viaOrgAdmin: viaOrg };
};

/**
 * The caller's whole standing in one group, resolved once. The individual
 * helpers each re-read the membership and the group, which is fine at a single
 * call site but wasteful for a screen that needs the full picture.
 */
export const resolveGroupAccess = async (
  userId: string,
  group: { id: string; organizationId: string },
  tx?: DbTransaction
): Promise<{ canView: boolean; canAdmin: boolean; viaOrgAdmin: boolean; isMember: boolean }> => {
  const membership = await getGroupUser(userId, group.id, tx);
  if (membership?.adminAccess) {
    return { canView: true, canAdmin: true, viaOrgAdmin: false, isMember: true };
  }

  const viaOrgAdmin = await isOrganizationAdmin(userId, group.organizationId, tx);

  return {
    canView: viaOrgAdmin || (membership?.viewAccess ?? false),
    canAdmin: viaOrgAdmin,
    viaOrgAdmin,
    isMember: membership !== undefined,
  };
};

/**
 * Every group the caller may administer: those their membership grants, plus
 * every live group of an organization they administer.
 *
 * `organizationId` confines the result to one organization. Mirroring passes
 * it: a user who owns one organization and holds a delegated grant in another
 * administers groups in both, and without the scope they could project a
 * second organization's leave into their own group.
 */
export const getAdministrableGroupIds = async (
  userId: string,
  options?: { organizationId?: string },
  tx?: DbTransaction
): Promise<string[]> => {
  const organizations = await getAdminOrganizationsForUser(userId, tx);
  const scoped = options?.organizationId
    ? organizations.filter((organization) => organization.id === options.organizationId)
    : organizations;

  const fromOrganizations = await getLiveGroupIdsForOrganizations(
    scoped.map((organization) => organization.id),
    tx
  );

  const fromMembership = await getAdminGroupIdsForUser(userId, tx);
  const membershipScoped = options?.organizationId
    ? await filterGroupIdsByOrganization(fromMembership, options.organizationId, tx)
    : fromMembership;

  return [...new Set([...membershipScoped, ...fromOrganizations])];
};

/** Throws 403 unless the caller's membership carries `adminAccess`, or they administer the group's organization. */
export const assertGroupAdmin = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<void> => {
  const { canAdmin } = await resolveGroupAdmin(userId, groupId, tx);
  if (!canAdmin) {
    throw new AppError({
      message: "No permission for related group",
      logging: true,
      code: 403,
      context: { userId, groupId },
    });
  }
};
