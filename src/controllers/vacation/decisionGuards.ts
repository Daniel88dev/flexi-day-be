import AppError from "../../utils/appError.js";
import type { DbTransaction } from "../../db/db.js";
import { createDBServices } from "../../services/DBServices.js";
import type { VacationType } from "../../services/vacation/types.js";

const services = createDBServices();

type Decision = "approve" | "reject";

/**
 * The single predicate for "may this person decide on these requests", shared by
 * the per-record and bulk endpoints so they cannot drift apart. Separation of
 * duties is part of it: an approver's own request is for the other approver.
 */
export const assertMayDecide = async (
  actorUserId: string,
  rows: Pick<VacationType, "id" | "userId" | "groupId">[],
  decision: Decision,
  tx?: DbTransaction
): Promise<void> => {
  const distinctGroupIds = Array.from(new Set(rows.map((row) => row.groupId)));
  const allowedGroupIds = new Set(
    await services.group.getGroupsWhereUserCanApprove(distinctGroupIds, actorUserId, tx)
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

  if (rows.some((row) => row.userId === actorUserId)) {
    throw new AppError({
      code: 403,
      message: "You cannot decide on your own leave request",
      logging: true,
      context: { actorUserId, vacationIds: rows.map((row) => row.id) },
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
