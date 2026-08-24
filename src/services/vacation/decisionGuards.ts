import AppError from "../../utils/appError.js";
import type { DbTransaction } from "../../db/db.js";
import type { VacationType } from "./types.js";
import { getGroupsWhereUserCanApprove } from "../group/groupServices.js";
import { hasMirrorIntoGroup } from "../groupMirror/groupMirrorServices.js";
import { getGroupUser } from "../groupUser/groupUserServices.js";

export type Decision = "approve" | "reject";

/**
 * Whether the actor may decide on their *own* request in this group. Only the
 * `approverAccess` flag lifts separation of duties, and not while the actor's
 * records are mirrored in from another group — that leave is governed there.
 */
export const mayDecideOwn = async (
  actorUserId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const membership = await getGroupUser(actorUserId, groupId, tx);
  if (!membership?.approverAccess) return false;

  return !(await hasMirrorIntoGroup(actorUserId, groupId, tx));
};

/**
 * The single predicate for "may this person decide on these requests", shared by
 * the per-record and bulk endpoints so they cannot drift apart.
 */
export const assertMayDecide = async (
  actorUserId: string,
  rows: Pick<VacationType, "id" | "userId" | "groupId">[],
  decision: Decision,
  tx?: DbTransaction
): Promise<void> => {
  const distinctGroupIds = Array.from(new Set(rows.map((row) => row.groupId)));
  const allowedGroupIds = new Set(
    await getGroupsWhereUserCanApprove(distinctGroupIds, actorUserId, tx)
  );

  const unauthorizedGroups = distinctGroupIds.filter((id) => !allowedGroupIds.has(id));
  if (unauthorizedGroups.length > 0) {
    throw new AppError({
      code: 403,
      message: `You are not allowed to ${decision} one or more of these requests`,
      logging: true,
      context: { actorUserId, unauthorizedGroups },
    });
  }

  const ownRows = rows.filter((row) => row.userId === actorUserId);
  if (ownRows.length === 0) return;

  const ownGroupIds = Array.from(new Set(ownRows.map((row) => row.groupId)));
  const selfDecidable = new Set<string>();
  for (const groupId of ownGroupIds) {
    if (await mayDecideOwn(actorUserId, groupId, tx)) selfDecidable.add(groupId);
  }

  const blocked = ownRows.filter((row) => !selfDecidable.has(row.groupId));
  if (blocked.length > 0) {
    throw new AppError({
      code: 403,
      message: "You cannot decide on your own leave request",
      logging: true,
      context: { actorUserId, vacationIds: blocked.map((row) => row.id) },
    });
  }
};

/** Fails fast with an explanation; the update predicate is the real guarantee. */
export const assertStillPending = (
  rows: Pick<VacationType, "id" | "approvedAt" | "rejectedAt" | "deletedAt">[]
): void => {
  const decided = rows.filter(
    (row) => row.approvedAt !== null || row.rejectedAt !== null || row.deletedAt !== null
  );
  if (decided.length > 0) {
    throw new AppError({
      code: 409,
      message: "This request has already been decided",
      logging: true,
      context: { vacationIds: decided.map((row) => row.id) },
    });
  }
};
