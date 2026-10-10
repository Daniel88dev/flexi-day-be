import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { collapsePendingApprovals } from "../../services/vacation/collapsePendingApprovals.js";
import { resolveCanApproveForList } from "../../services/vacation/vacationPermissions.js";
import { getPendingRequestsForRequester } from "../../services/vacation/vacationServices.js";

export const handleGetMyPendingRequests = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const rows = await getPendingRequestsForRequester(auth.userId);
  // Rows the caller may decide are listed by /me/approvals instead.
  const canDecide = await resolveCanApproveForList(auth.userId, rows);

  return res.status(200).json(collapsePendingApprovals(rows.filter((row) => !canDecide(row))));
};
