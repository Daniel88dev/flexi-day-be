import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedBulkApproveVacationType } from "../../services/vacation/types.js";
import { approveRequestBatch } from "../../services/vacation/vacationTransitions.js";

/**
 * Atomically approves many vacation rows. Used by the approvals widget after
 * the FE collapses contiguous day rows into a single approval entry — the FE
 * sends the full `vacationIds` array so a partial failure cannot leave half
 * the range approved.
 */
export const handleBulkApproveVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedBulkApproveVacationType = req.body;

  const approved = await approveRequestBatch({ auth, vacationIds: data.ids });

  return res.status(200).json({
    message: "Vacations approved",
    approvedCount: approved.length,
  });
};
