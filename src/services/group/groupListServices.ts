import type { GroupType } from "./types.js";
import { getAllGroups } from "./groupServices.js";
import { getAdministrableGroupIds } from "../groupUser/groupAccess.js";
import { countMembersByGroup, getAllGroupsForUser } from "../groupUser/groupUserServices.js";
import {
  resolveOrganizationBadges,
  type OrganizationBadge,
} from "../organization/organizationBadge.js";
import { isAttachmentUploadAvailable } from "../billing/guards.js";

type MembershipFlags = { adminAccess: boolean; approverAccess: boolean };

export type GroupListItem = GroupType & {
  organization: OrganizationBadge | null;
  memberCount: number;
  uploadsAvailable: boolean;
  membership: MembershipFlags;
};

export type AdministeredGroupListItem = GroupListItem & { viaOrgAdmin: boolean };

/** The `GET /api/group` item shape, shared so every group list renders the same card. */
export const toGroupListItems = async (
  groups: GroupType[],
  membershipByGroup: Map<string, MembershipFlags>
): Promise<GroupListItem[]> => {
  const groupIds = groups.map((group) => group.id);
  const organizationIds = [...new Set(groups.map((group) => group.organizationId))];
  const [badges, memberCounts, uploads] = await Promise.all([
    resolveOrganizationBadges(organizationIds),
    countMembersByGroup(groupIds),
    Promise.all(
      organizationIds.map(async (id) => [id, await isAttachmentUploadAvailable(id)] as const)
    ),
  ]);
  const uploadsByOrganization = new Map(uploads);

  return groups.map((group) => {
    const membership = membershipByGroup.get(group.id);
    return {
      ...group,
      organization: badges.get(group.organizationId) ?? null,
      memberCount: memberCounts.get(group.id) ?? 0,
      uploadsAvailable: uploadsByOrganization.get(group.organizationId) ?? false,
      membership: {
        adminAccess: membership?.adminAccess ?? false,
        approverAccess: membership?.approverAccess ?? false,
      },
    };
  });
};

export const getAdministeredGroups = async (
  userId: string
): Promise<AdministeredGroupListItem[]> => {
  const [administrable, memberships] = await Promise.all([
    getAdministrableGroupIds(userId),
    getAllGroupsForUser(userId),
  ]);
  const memberOf = new Set(memberships.map((membership) => membership.groupId));

  const groups = await getAllGroups(administrable.filter((id) => !memberOf.has(id)));
  const items = await toGroupListItems(groups, new Map());

  return items.map((item) => ({ ...item, viaOrgAdmin: item.managerUserId !== userId }));
};
