import type { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import type { PendingApprovalRow } from "./vacationServices.js";
import { buildUserSummary, type UserSummary } from "../../utils/userPresentation.js";

export type PendingApprovalEntry = {
  vacationIds: string[];
  user: UserSummary;
  groupId: string;
  groupName: string;
  vacationType: CalendarRecordType;
  from: string;
  to: string;
  businessDays: number;
  note: string | null;
  submittedAt: string;
};

/**
 * Collapses pending day rows into one approval entry per Request (rows sharing
 * a `requestId`), so callers see one item per booking instead of one per day.
 * A Request's rows have gaps wherever it skipped a weekend or public holiday,
 * so membership never depends on the days being adjacent.
 */
export const collapsePendingApprovals = (rows: PendingApprovalRow[]): PendingApprovalEntry[] => {
  const entries = new Map<string, PendingApprovalEntry>();

  for (const row of rows) {
    const key = JSON.stringify([row.userId, row.groupId, row.vacationType, row.requestId]);
    const entry = entries.get(key);

    if (!entry) {
      entries.set(key, {
        vacationIds: [row.vacationId],
        user: buildUserSummary({ id: row.userId, name: row.userName }),
        groupId: row.groupId,
        groupName: row.groupName,
        vacationType: row.vacationType,
        from: row.requestedDay,
        to: row.requestedDay,
        businessDays: 1,
        note: row.note,
        submittedAt: row.submittedAt.toISOString(),
      });
      continue;
    }

    entry.vacationIds.push(row.vacationId);
    entry.businessDays = entry.vacationIds.length;
    if (row.requestedDay < entry.from) entry.from = row.requestedDay;
    if (row.requestedDay > entry.to) entry.to = row.requestedDay;
    if (!entry.note && row.note) entry.note = row.note;
    if (row.submittedAt.getTime() < new Date(entry.submittedAt).getTime()) {
      entry.submittedAt = row.submittedAt.toISOString();
    }
  }

  return [...entries.values()];
};
