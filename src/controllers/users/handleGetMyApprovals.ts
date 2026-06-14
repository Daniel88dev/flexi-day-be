import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { collapsePendingApprovals } from "../../services/vacation/collapsePendingApprovals.js";

const services = createDBServices();

export const handleGetMyApprovals = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const rows = await services.vacation.getPendingApprovalsForApprover(
    auth.userId
  );

  return res.status(200).json(collapsePendingApprovals(rows));
};
