import type { vacationType } from "../../db/schema/vacation-schema.js";
import type { PendingApprovalRow } from "./vacationServices.js";
import { countBusinessDaysInclusive } from "../../utils/dateFunc.js";
import {
  buildUserSummary,
  type UserSummary,
} from "../../utils/userPresentation.js";

export type PendingApprovalEntry = {
  vacationIds: string[];
  user: UserSummary;
  groupId: string;
  groupName: string;
  vacationType: vacationType;
  from: string;
  to: string;
  businessDays: number;
  note: string | null;
  submittedAt: string;
};

const addOneDay = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Collapses contiguous (user, group, vacationType) day rows into a single
 * approval entry so callers see one item per booking instead of one per day.
 *
 * Shared by `GET /api/users/me/approvals` (the list) and by
 * `dashboard-summary.pendingApprovalsCount` so both stay consistent — the
 * stat-card count must always equal the list length.
 *
 * Input rows must be ordered by (userId, groupId, vacationType, requestedDay)
 * — every key the collapse predicate compares against, plus the date last so
 * contiguous days within the same (user, group, type) appear adjacent.
 * `getPendingApprovalsForApprover` returns rows in exactly this order.
 */
export const collapsePendingApprovals = (
  rows: PendingApprovalRow[]
): PendingApprovalEntry[] => {
  const result: PendingApprovalEntry[] = [];

  for (const row of rows) {
    const last = result[result.length - 1];
    if (
      last &&
      last.user.id === row.userId &&
      last.groupId === row.groupId &&
      last.vacationType === row.vacationType &&
      addOneDay(last.to) === row.requestedDay
    ) {
      last.vacationIds.push(row.vacationId);
      last.to = row.requestedDay;
      last.businessDays = countBusinessDaysInclusive(last.from, last.to);
      if (!last.note && row.note) last.note = row.note;
      if (row.submittedAt.getTime() < new Date(last.submittedAt).getTime()) {
        last.submittedAt = row.submittedAt.toISOString();
      }
      continue;
    }

    result.push({
      vacationIds: [row.vacationId],
      user: buildUserSummary({ id: row.userId, name: row.userName }),
      groupId: row.groupId,
      groupName: row.groupName,
      vacationType: row.vacationType,
      from: row.requestedDay,
      to: row.requestedDay,
      businessDays: countBusinessDaysInclusive(
        row.requestedDay,
        row.requestedDay
      ),
      note: row.note,
      submittedAt: row.submittedAt.toISOString(),
    });
  }

  return result;
};
