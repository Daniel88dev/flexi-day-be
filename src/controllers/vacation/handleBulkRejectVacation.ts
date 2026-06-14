import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import type { ValidatedBulkRejectVacationType } from "../../services/vacation/types.js";

const services = createDBServices();

export const handleBulkRejectVacation = async (
  req: Request,
  res: Response
) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedBulkRejectVacationType = req.body;
  const uniqueIds = Array.from(new Set(data.ids));

  const rejected = await db.transaction(async (tx) => {
    const rows = await services.vacation.getVacationsByIds(uniqueIds, tx);

    if (rows.length !== uniqueIds.length) {
      throw new AppError({
        code: 404,
        message: "One or more vacations not found",
        context: { auth, requested: uniqueIds.length, found: rows.length },
      });
    }

    const distinctGroupIds = Array.from(new Set(rows.map((r) => r.groupId)));
    const allowedGroupIds = new Set(
      await services.group.getGroupsWhereUserCanApprove(
        distinctGroupIds,
        auth.userId,
        tx
      )
    );

    const unauthorizedGroups = distinctGroupIds.filter(
      (id) => !allowedGroupIds.has(id)
    );
    if (unauthorizedGroups.length > 0) {
      throw new AppError({
        code: 403,
        message: "You are not allowed to reject one or more of these vacations",
        context: { auth, unauthorizedGroups },
      });
    }

    return services.vacation.rejectVacationsBulk(
      uniqueIds,
      auth.userId,
      data.reason ?? null,
      tx
    );
  });

  return res.status(200).json({
    message: "Vacations rejected",
    rejectedCount: rejected.length,
  });
};
