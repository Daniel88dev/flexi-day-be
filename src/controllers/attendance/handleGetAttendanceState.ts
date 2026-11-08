import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { readOwnAttendanceState } from "../../services/attendance/ownAttendance.js";
import { attendanceScopeOfQuery, presentAttendanceState } from "./utils.js";

export const handleGetAttendanceState = async (req: Request, res: Response) => {
  const state = await readOwnAttendanceState({
    auth: getAuth(req),
    organizationId: attendanceScopeOfQuery(req),
  });

  return res.status(200).json(presentAttendanceState(state));
};
