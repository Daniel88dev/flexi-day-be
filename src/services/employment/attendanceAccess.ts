import type { DbTransaction } from "../../db/db.js";
import AppError from "../../utils/appError.js";
import { isOrganizationAdmin } from "../organization/organizationServices.js";
import { getAdministrableGroupIds } from "../groupUser/groupAccess.js";
import {
  getActiveGroupIdsInOrganization,
  getActiveMemberIdsForGroups,
} from "../groupUser/groupUserServices.js";

/**
 * Who may read an Employment, from the visibility table in
 * `docs/attendance.md`: its own user, the group admins of any group that
 * person belongs to, and the organization's admins. Correction rights follow
 * the same lines, so the sessions ticket authorizes from here rather than
 * writing a second matrix.
 *
 * Sitting in the services layer beside `groupUser/groupAccess.ts`, for the
 * reason `CLAUDE.md` gives — attendance writes will authorize from the
 * transition path as well as from a controller, and a guard a layer up could
 * not be reached from there.
 *
 * Two corollaries the shape makes rather than states: a manager holds no
 * `group_users` row, so no group admin's scope contains their Employment, and
 * an Employment in no group at all is visible only to org admins.
 */

type EmploymentSubject = { organizationId: string; userId: string };

export type EmploymentAudience = { everyone: true } | { everyone: false; userIds: string[] };

export const canReadEmployment = async (
  viewerUserId: string,
  employment: EmploymentSubject,
  tx?: DbTransaction
): Promise<boolean> => {
  if (viewerUserId === employment.userId) return true;

  if (await isOrganizationAdmin(viewerUserId, employment.organizationId, tx)) return true;

  const subjectGroupIds = await getActiveGroupIdsInOrganization(
    employment.userId,
    employment.organizationId,
    tx
  );
  if (subjectGroupIds.length === 0) return false;

  const administrable = await getAdministrableGroupIds(
    viewerUserId,
    { organizationId: employment.organizationId },
    tx
  );
  const administrableSet = new Set(administrable);

  return subjectGroupIds.some((groupId) => administrableSet.has(groupId));
};

export const assertEmploymentReadable = async (
  viewerUserId: string,
  employment: EmploymentSubject,
  tx?: DbTransaction
): Promise<void> => {
  if (await canReadEmployment(viewerUserId, employment, tx)) return;

  throw new AppError({
    message: "No permission for this employment",
    logging: true,
    code: 403,
    context: {
      viewerUserId,
      organizationId: employment.organizationId,
      target: employment.userId,
    },
  });
};

/**
 * The slice of the roster the viewer may list: the whole organization, or the
 * members of the groups they administer. Throws 403 for someone who administers
 * nothing in it — the roster is an admin surface, and anyone's own row, a group
 * admin's included, is read one at a time from `GET /api/employment`.
 */
export const resolveRosterAudience = async (
  viewerUserId: string,
  organizationId: string,
  tx?: DbTransaction
): Promise<EmploymentAudience> => {
  if (await isOrganizationAdmin(viewerUserId, organizationId, tx)) return { everyone: true };

  const administrable = await getAdministrableGroupIds(viewerUserId, { organizationId }, tx);
  if (administrable.length === 0) {
    throw new AppError({
      message: "No permission for related organization",
      logging: true,
      code: 403,
      context: { viewerUserId, organizationId },
    });
  }

  return { everyone: false, userIds: await getActiveMemberIdsForGroups(administrable, tx) };
};
