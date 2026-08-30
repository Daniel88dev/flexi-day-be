import { getAdminGroupIdsForUser, getGroupUser } from "./groupUserServices.js";
import {
  filterGroupIdsByOrganization,
  getGroup,
  getLiveGroupIdsForOrganizations,
  getManagedGroupIdsForUser,
} from "../group/groupServices.js";
import {
  getAdminOrganizationsForUser,
  isOrganizationAdmin,
} from "../organization/organizationServices.js";
import type { DbTransaction } from "../../db/db.js";
import AppError from "../../utils/appError.js";

export const validateUserGroupAccess = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const groupUser = await getGroupUser(userId, groupId, tx);
  if (groupUser?.viewAccess) return true;
  const group = await getGroup(groupId, tx);
  if (!group) return false;
  if (group.managerUserId === userId) return true;
  return isOrganizationAdmin(userId, group.organizationId, tx);
};

/**
 * Whether the caller may administer the group, and whether that authority came
 * from the organization rather than a membership — the UI surfaces the
 * difference so nobody edits another team believing they belong to it.
 *
 * The group's manager administers it in their own right (CONTEXT.md: a group
 * admin is "the manager, or an org admin"), so a manager reports
 * `viaOrgAdmin: false`. Org admins get only administration through here —
 * approver rights are a workflow role resolved by `getGroupsWhereUserCanApprove`,
 * which accepts the manager but never a bare org admin.
 */
export const resolveGroupAdmin = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<{ canAdmin: boolean; viaOrgAdmin: boolean }> => {
  const groupUser = await getGroupUser(userId, groupId, tx);
  if (groupUser?.adminAccess) return { canAdmin: true, viaOrgAdmin: false };

  const group = await getGroup(groupId, tx);
  if (!group) return { canAdmin: false, viaOrgAdmin: false };
  if (group.managerUserId === userId) return { canAdmin: true, viaOrgAdmin: false };

  const viaOrg = await isOrganizationAdmin(userId, group.organizationId, tx);
  return { canAdmin: viaOrg, viaOrgAdmin: viaOrg };
};

/**
 * The caller's whole standing in one group, resolved once. The individual
 * helpers each re-read the membership and the group, which is fine at a single
 * call site but wasteful for a screen that needs the full picture.
 */
export const resolveGroupAccess = async (
  userId: string,
  group: { id: string; organizationId: string; managerUserId: string },
  tx?: DbTransaction
): Promise<{ canView: boolean; canAdmin: boolean; viaOrgAdmin: boolean; isMember: boolean }> => {
  const membership = await getGroupUser(userId, group.id, tx);
  const isMember = membership !== undefined;
  if (membership?.adminAccess || group.managerUserId === userId) {
    return { canView: true, canAdmin: true, viaOrgAdmin: false, isMember };
  }

  const viaOrgAdmin = await isOrganizationAdmin(userId, group.organizationId, tx);

  return {
    canView: viaOrgAdmin || (membership?.viewAccess ?? false),
    canAdmin: viaOrgAdmin,
    viaOrgAdmin,
    isMember,
  };
};

/**
 * Every group the caller may administer: those their membership grants, those
 * they manage, plus every live group of an organization they administer.
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
  const fromManaged = await getManagedGroupIdsForUser(userId, tx);
  const direct = [...fromMembership, ...fromManaged];
  const directScoped = options?.organizationId
    ? await filterGroupIdsByOrganization(direct, options.organizationId, tx)
    : direct;

  return [...new Set([...directScoped, ...fromOrganizations])];
};

/** Throws 403 unless the caller's membership carries `adminAccess`, they manage the group, or they administer its organization. */
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
