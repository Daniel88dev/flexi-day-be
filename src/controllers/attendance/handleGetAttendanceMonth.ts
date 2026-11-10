import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { readOwnAttendanceMonth } from "../../services/attendance/ownAttendance.js";
import { validateAttendanceMonthQuery } from "../../services/attendance/types.js";
import { presentAttendanceMonth } from "./utils.js";

export const handleGetAttendanceMonth = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const query = validateAttendanceMonthQuery.parse(req.query);

  const month = await readOwnAttendanceMonth({ auth, query });

  return res.status(200).json(presentAttendanceMonth(month));
};
