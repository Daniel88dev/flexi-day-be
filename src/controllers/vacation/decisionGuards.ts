import AppError from "../../utils/appError.js";
import type { DbTransaction } from "../../db/db.js";
import { createDBServices } from "../../services/DBServices.js";
import type { VacationType } from "../../services/vacation/types.js";

const services = createDBServices();

type Decision = "approve" | "reject";

/**
 * The single predicate for "may this person decide on these requests".
 *
 * Both the per-record and the bulk endpoints route through here so the same
 * user acting on the same request cannot be refused by one button and obeyed by
 * another — previously the bulk path accepted the group manager while the
 * single path accepted only the named approvers, and sending a one-element
 * array bypassed the stricter of the two.
 *
 * Separation of duties is part of the predicate: an approver's own request is
 * for the group's other approver to decide, never for themselves.
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

/**
 * A decision is only meaningful on an open request. Checked here so the caller
 * gets a 409 explaining what happened rather than the update silently matching
 * no rows — or, before the update predicate was tightened, silently overturning
 * the earlier decision.
 */
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
