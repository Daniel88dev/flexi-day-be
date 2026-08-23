import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedBulkCancelVacationType } from "../../services/vacation/types.js";
import { cancelRequestBatch } from "../../services/vacation/vacationTransitions.js";

export const handleBulkCancelVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedBulkCancelVacationType = req.body;

  const cancelled = await cancelRequestBatch({
    auth,
    vacationIds: data.ids,
    reason: data.reason ?? null,
  });

  return res.status(200).json({
    message: "Vacations cancelled",
    cancelledCount: cancelled.length,
  });
};
