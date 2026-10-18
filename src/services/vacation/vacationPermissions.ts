import type { DbTransaction } from "../../db/db.js";
import type { LiveVacationType, VacationType } from "./types.js";
import type { VacationViewer } from "./redaction.js";
import { mayDecideOwn } from "./decisionGuards.js";
import { resolveGroupAdmin } from "../groupUser/groupAccess.js";
import { getGroupsWhereUserCanApprove } from "../group/groupServices.js";
import { getGroupUser } from "../groupUser/groupUserServices.js";

export type VacationPermissions = {
  /** May see the request at all. */
  canView: boolean;
  /** May approve or reject it (only meaningful while it is pending). */
  canApprove: boolean;
  /** May cancel it — the owner, a group admin, or an approver. */
  canCancel: boolean;
  /** May edit its per-day fields — group or organization admins only. */
  canEdit: boolean;
  /** May read its Private details and comment on it: the owner, or an approver or group admin of the row's own group. */
  canReadPrivateDetails: boolean;
  /** May see and fetch the Request's attachments — owner, approvers and admins, not view-only members. */
  canViewAttachments: boolean;
  /** May add an attachment to the Request — the owner or an admin, while it is neither cancelled nor rejected. Plan and count apply on top. */
  canAttach: boolean;
  /** May delete any of the Request's attachments, not only their own — group and organization admins. An uploader may always delete what they uploaded. */
  canDeleteAnyAttachment: boolean;
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

  const membership = await getGroupUser(userId, vacationRow.groupId, tx);
  const approvableGroups = await getGroupsWhereUserCanApprove([vacationRow.groupId], userId, tx);
  const isApprover = approvableGroups.includes(vacationRow.groupId);
  // Group admins and org admins alike: they may manage records on behalf of
  // members (create / edit / cancel), which is administration — deciding a
  // member-submitted request stays an approver-only power (`canApprove`).
  const { canAdmin } = await resolveGroupAdmin(userId, vacationRow.groupId, tx);
  // Nullish, not strict: a row whose stamp is absent rather than null is live.
  // A strict test reads `undefined` as cancelled and denies the owner.
  const isCancelled = vacationRow.deletedAt != null;
  // A decision is final; re-deciding would overturn it and wipe its stamps.
  const isDecidable =
    !isCancelled && vacationRow.approvedAt === null && vacationRow.rejectedAt === null;
  const ownAllowed =
    isOwner && isApprover ? await mayDecideOwn(userId, vacationRow.groupId, tx) : false;

  const canEdit = canAdmin && !isCancelled && vacationRow.rejectedAt === null;
  const canReadPrivateDetails = isOwner || isApprover || canAdmin;

  return {
    canView: isOwner || isApprover || canAdmin || (membership?.viewAccess ?? false),
    canApprove: isApprover && isDecidable && (!isOwner || ownAllowed),
    canCancel: !isCancelled && (isOwner || canAdmin || isApprover),
    canEdit,
    canReadPrivateDetails,
    canViewAttachments: canReadPrivateDetails,
    canAttach: (isOwner && !isCancelled && vacationRow.rejectedAt === null) || canEdit,
    canDeleteAnyAttachment: canAdmin,
  };
};

/**
 * The groups among `groupIds` where the user is an approver or a group admin:
 * the privileged set a `VacationViewer` carries. Queries scale with the
 * distinct groups, not the rows.
 */
export const resolvePrivilegedGroupIds = async (
  userId: string,
  groupIds: string[],
  tx?: DbTransaction
): Promise<Set<string>> => {
  const distinct = Array.from(new Set(groupIds));
  const privileged = new Set(await getGroupsWhereUserCanApprove(distinct, userId, tx));

  for (const groupId of distinct) {
    const { canAdmin } = await resolveGroupAdmin(userId, groupId, tx);
    if (canAdmin) privileged.add(groupId);
  }

  return privileged;
};

/** The viewer `viewVacationRowAs` takes, for rows from any of `groupIds`. */
export const resolveVacationViewer = async (
  userId: string,
  groupIds: string[],
  tx?: DbTransaction
): Promise<VacationViewer> => ({
  userId,
  privilegedGroupIds: await resolvePrivilegedGroupIds(userId, groupIds, tx),
});

type LiveVacationRow = Pick<LiveVacationType, "userId" | "groupId" | "deletedAt">;

/**
 * The same `canCancel` verdict as {@link resolveVacationPermissions}, for a
 * whole list in a number of queries that scales with the distinct groups in the
 * batch rather than with its rows — the per-record form would turn a
 * fifty-record cancel into hundreds of queries inside an open transaction
 * holding row locks. It carries no cancelled-row term; the row type is what
 * keeps a soft-deleted row out, so only a live-only reader can feed it.
 */
export const resolveCanCancelForList = async <T extends LiveVacationRow>(
  userId: string,
  rows: T[],
  tx?: DbTransaction
): Promise<(row: T) => boolean> => {
  const privileged = await resolvePrivilegedGroupIds(
    userId,
    rows.map((row) => row.groupId),
    tx
  );

  return (row) => row.userId === userId || privileged.has(row.groupId);
};

type DecidableRow = Pick<
  VacationType,
  "userId" | "groupId" | "deletedAt" | "approvedAt" | "rejectedAt"
>;

/**
 * The same `canApprove` verdict as {@link resolveVacationPermissions}, for a
 * whole list in a number of queries that scales with the distinct groups in the
 * batch rather than with its rows.
 */
export const resolveCanApproveForList = async <T extends DecidableRow>(
  userId: string,
  rows: T[]
): Promise<(row: T) => boolean> => {
  const groupIds = Array.from(new Set(rows.map((row) => row.groupId)));
  const approvable = new Set(await getGroupsWhereUserCanApprove(groupIds, userId));

  const ownGroupIds = Array.from(
    new Set(rows.filter((row) => row.userId === userId).map((row) => row.groupId))
  ).filter((groupId) => approvable.has(groupId));

  const selfDecidable = new Set<string>();
  for (const groupId of ownGroupIds) {
    if (await mayDecideOwn(userId, groupId)) selfDecidable.add(groupId);
  }

  return (row) => {
    if (!approvable.has(row.groupId)) return false;
    if (row.deletedAt != null || row.approvedAt !== null || row.rejectedAt !== null) return false;
    return row.userId !== userId || selfDecidable.has(row.groupId);
  };
};
