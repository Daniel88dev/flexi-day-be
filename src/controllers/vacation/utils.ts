import { createDBServices } from "../../services/DBServices.js";
import type { DbTransaction } from "../../db/db.js";
import type { VacationType } from "../../services/vacation/types.js";

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

  return {
    canView: isOwner || isApprover || (membership?.viewAccess ?? false),
    canApprove: isApprover && !isOwner && isDecidable,
    canCancel: !isCancelled && (isOwner || isAdmin || isApprover),
  };
};
