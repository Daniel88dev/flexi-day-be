import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { collapsePendingApprovals } from "../../services/vacation/collapsePendingApprovals.js";
import { getPendingApprovalsForApprover } from "../../services/vacation/vacationServices.js";

export const handleGetMyApprovals = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const rows = await getPendingApprovalsForApprover(auth.userId);

  return res.status(200).json(collapsePendingApprovals(rows));
};
