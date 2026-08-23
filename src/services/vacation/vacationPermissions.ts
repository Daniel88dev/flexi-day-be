import { createDBServices } from "../DBServices.js";
import type { DbTransaction } from "../../db/db.js";
import type { VacationType } from "./types.js";
import { mayDecideOwn } from "./decisionGuards.js";
import { resolveGroupAdmin } from "../groupUser/groupAccess.js";

const services = createDBServices();

export type VacationPermissions = {
  /** May see the request at all. */
  canView: boolean;
  /** May approve or reject it (only meaningful while it is pending). */
  canApprove: boolean;
  /** May cancel it — the owner, a group admin, or an approver. */
  canCancel: boolean;
  /** May edit its per-day fields — group or organization admins only. */
  canEdit: boolean;
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
  // Group admins and org admins alike: they may manage records on behalf of
  // members (create / edit / cancel), which is administration — deciding a
  // member-submitted request stays an approver-only power (`canApprove`).
  const { canAdmin } = await resolveGroupAdmin(userId, vacationRow.groupId, tx);
  const isCancelled = vacationRow.deletedAt !== null;
  // A decision is final; re-deciding would overturn it and wipe its stamps.
  const isDecidable =
    !isCancelled && vacationRow.approvedAt === null && vacationRow.rejectedAt === null;
  const ownAllowed =
    isOwner && isApprover ? await mayDecideOwn(userId, vacationRow.groupId, tx) : false;

  return {
    canView: isOwner || isApprover || canAdmin || (membership?.viewAccess ?? false),
    canApprove: isApprover && isDecidable && (!isOwner || ownAllowed),
    canCancel: !isCancelled && (isOwner || canAdmin || isApprover),
    canEdit: canAdmin && !isCancelled && vacationRow.rejectedAt === null,
  };
};

/** A row a live-only reader returned — never a soft-deleted one. */
type LiveVacationRow = Pick<VacationType, "userId" | "groupId">;

/**
 * The same `canCancel` verdict as {@link resolveVacationPermissions}, for a
 * whole list in a fixed number of queries — the per-record form would turn a
 * fifty-record cancel into hundreds of queries inside an open transaction
 * holding row locks. It carries no cancelled-row term, so the rows must come
 * from a reader that excludes them.
 */
export const resolveCanCancelForList = async <T extends LiveVacationRow>(
  userId: string,
  rows: T[],
  tx?: DbTransaction
): Promise<(row: T) => boolean> => {
  const groupIds = Array.from(new Set(rows.map((row) => row.groupId)));
  const approvable = new Set(
    await services.group.getGroupsWhereUserCanApprove(groupIds, userId, tx)
  );

  const adminGroups = new Set<string>();
  for (const groupId of groupIds) {
    const { canAdmin } = await resolveGroupAdmin(userId, groupId, tx);
    if (canAdmin) adminGroups.add(groupId);
  }

  return (row) =>
    row.userId === userId || approvable.has(row.groupId) || adminGroups.has(row.groupId);
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
