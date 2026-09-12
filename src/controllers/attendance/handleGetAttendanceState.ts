import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getAttendanceState } from "../../services/attendance/attendanceServices.js";
import { attendanceScopeOfQuery, presentAttendanceState } from "./utils.js";

/**
 * Everything the clock widget renders from, in one read: the open session and
 * break, today's sessions, and whether attendance is active and location on.
 * Never gated by the plan — a lapsed organization's history stays readable and
 * the widget needs `active: false` to say so.
 */
export const handleGetAttendanceState = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const state = await getAttendanceState(auth.userId, attendanceScopeOfQuery(req));

  return res.status(200).json(presentAttendanceState(state));
};
