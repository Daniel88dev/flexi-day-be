import AppError from "../../utils/appError.js";
import { hasOrganizationLink } from "../employment/organizationLinks.js";
import { filterGroupIdsByOrganization } from "../group/groupServices.js";

export const OUTSIDE_ORGANIZATION = "OUTSIDE_ORGANIZATION";

/**
 * The same answer for "outside the organization" and "does not exist", so a
 * caller learns nothing about groups and people elsewhere.
 */
const outside = (what: "Group" | "Person", context: object) =>
  new AppError({
    code: 404,
    message: `${what} not found`,
    logging: true,
    context,
    publicContext: { code: OUTSIDE_ORGANIZATION },
  });

/** Rejects any group that is not a live group of the organization. */
export const assertGroupsInOrganization = async (
  organizationId: string,
  groupIds: string[]
): Promise<void> => {
  const wanted = [...new Set(groupIds)];
  if (wanted.length === 0) return;
  const inside = new Set(await filterGroupIdsByOrganization(wanted, organizationId));
  const stray = wanted.filter((groupId) => !inside.has(groupId));
  if (stray.length > 0) throw outside("Group", { organizationId, groupIds: stray });
};

/** Rejects any person the organization does not link by one of ADR 0004's four links. */
export const assertPeopleInOrganization = async (
  organizationId: string,
  userIds: string[]
): Promise<void> => {
  for (const userId of new Set(userIds)) {
    if (!(await hasOrganizationLink(userId, organizationId))) {
      throw outside("Person", { organizationId, userId });
    }
  }
};
