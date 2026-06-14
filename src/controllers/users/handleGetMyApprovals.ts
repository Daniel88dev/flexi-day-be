import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import type { PendingApprovalRow } from "../../services/vacation/vacationServices.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { countBusinessDaysInclusive } from "../../utils/dateFunc.js";
import type { vacationType } from "../../db/schema/vacation-schema.js";

const services = createDBServices();

type PendingApprovalResponse = {
  vacationId: string;
  user: ReturnType<typeof buildUserSummary>;
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
 * range entry so the FE renders one approval per booking instead of one per
 * day.
 */
const collapseRanges = (
  rows: PendingApprovalRow[]
): PendingApprovalResponse[] => {
  const result: PendingApprovalResponse[] = [];

  for (const row of rows) {
    const last = result[result.length - 1];
    if (
      last &&
      last.user.id === row.userId &&
      last.groupId === row.groupId &&
      last.vacationType === row.vacationType &&
      addOneDay(last.to) === row.requestedDay
    ) {
      last.to = row.requestedDay;
      last.businessDays = countBusinessDaysInclusive(last.from, last.to);
      if (!last.note && row.note) last.note = row.note;
      if (row.submittedAt.getTime() < new Date(last.submittedAt).getTime()) {
        last.submittedAt = row.submittedAt.toISOString();
      }
      continue;
    }

    result.push({
      vacationId: row.vacationId,
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

export const handleGetMyApprovals = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const rows = await services.vacation.getPendingApprovalsForApprover(
    auth.userId
  );

  return res.status(200).json(collapseRanges(rows));
};
