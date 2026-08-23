import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedBulkRejectVacationType } from "../../services/vacation/types.js";
import { rejectRequestBatch } from "../../services/vacation/vacationTransitions.js";

export const handleBulkRejectVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedBulkRejectVacationType = req.body;

  const rejected = await rejectRequestBatch({
    auth,
    vacationIds: data.ids,
    reason: data.reason ?? null,
  });

  return res.status(200).json({
    message: "Vacations rejected",
    rejectedCount: rejected.length,
  });
};
