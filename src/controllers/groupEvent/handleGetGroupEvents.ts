import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { validateGroupEventsQuery } from "../../services/groupEvent/types.js";
import { listGroupEventsForMonth } from "../../services/groupEvent/groupEventAccess.js";

export const handleGetGroupEvents = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const query = validateGroupEventsQuery.parse(req.query);
  return res.status(200).json(await listGroupEventsForMonth(auth.userId, query));
};
