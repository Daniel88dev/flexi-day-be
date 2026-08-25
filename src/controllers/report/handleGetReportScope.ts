import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getReportScope } from "../../services/report/reportServices.js";

/**
 * Everything the report's filter controls need: which groups the caller may
 * report on, which members are selectable inside them, and which years hold
 * any data. Never 403s — a member with no view access anywhere still gets
 * their own groups back, scoped to themselves.
 */
export const handleGetReportScope = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const scope = await getReportScope(auth.userId);

  return res.status(200).json(scope);
};
