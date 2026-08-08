import { createDBServices } from "../../services/DBServices.js";
import type { DbTransaction } from "../../db/db.js";
import type { VacationType } from "../../services/vacation/types.js";
import { mayDecideOwn } from "./decisionGuards.js";

const services = createDBServices();

export type VacationPermissions = {
  /** May see the request at all. */
  canView: boolean;
  /** May approve or reject it (only meaningful while it is pending). */
  canApprove: boolean;
  /** May cancel it — the owner, a group admin, or an approver. */
  canCancel: boolean;
};

/**
 * Resolves what the caller may do with a vacation row. Kept in one place so
 * the detail endpoint reports exactly the actions the mutation endpoints will
 * actually allow.
 */
export const resolveVacationPermissions = async (
  userId: string,
  vacationRow: Pick<VacationType, "userId" | "groupId" | "deletedAt" | "approvedAt" | "rejectedAt">,
  tx?: DbTransaction
): Promise<VacationPermissions> => {
  const isOwner = vacationRow.userId === userId;

  const membership = await services.groupUser.getGroupUser(userId, vacationRow.groupId, tx);
  const approvableGroups = await services.group.getGroupsWhereUserCanApprove(
    [vacationRow.groupId],
    userId,
    tx
  );
  const isApprover = approvableGroups.includes(vacationRow.groupId);
  const isAdmin = membership?.adminAccess ?? false;
  const isCancelled = vacationRow.deletedAt !== null;
  // A decision is final; re-deciding would overturn it and wipe its stamps.
  const isDecidable =
    !isCancelled && vacationRow.approvedAt === null && vacationRow.rejectedAt === null;
  const ownAllowed =
    isOwner && isApprover ? await mayDecideOwn(userId, vacationRow.groupId, tx) : false;

  return {
    canView: isOwner || isApprover || (membership?.viewAccess ?? false),
    canApprove: isApprover && isDecidable && (!isOwner || ownAllowed),
    canCancel: !isCancelled && (isOwner || isAdmin || isApprover),
  };
};

type DecidableRow = Pick<
  VacationType,
  "userId" | "groupId" | "deletedAt" | "approvedAt" | "rejectedAt"
>;

/**
 * The same `canApprove` verdict as {@link resolveVacationPermissions}, for a
 * whole list in a fixed number of queries.
 */
export const resolveCanApproveForList = async <T extends DecidableRow>(
  userId: string,
  rows: T[]
): Promise<(row: T) => boolean> => {
  const groupIds = Array.from(new Set(rows.map((row) => row.groupId)));
  const approvable = new Set(await services.group.getGroupsWhereUserCanApprove(groupIds, userId));

  const ownGroupIds = Array.from(
    new Set(rows.filter((row) => row.userId === userId).map((row) => row.groupId))
  ).filter((groupId) => approvable.has(groupId));

  const selfDecidable = new Set<string>();
  for (const groupId of ownGroupIds) {
    if (await mayDecideOwn(userId, groupId)) selfDecidable.add(groupId);
  }

  return (row) => {
    if (!approvable.has(row.groupId)) return false;
    if (row.deletedAt !== null || row.approvedAt !== null || row.rejectedAt !== null) return false;
    return row.userId !== userId || selfDecidable.has(row.groupId);
  };
};
