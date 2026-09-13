import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getAttendanceDay } from "../../services/attendance/attendanceServices.js";
import { validateAttendanceDayQuery } from "../../services/attendance/types.js";
import { presentSession } from "./utils.js";

export const handleGetAttendanceDay = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const query = validateAttendanceDayQuery.parse(req.query);
  const day = await getAttendanceDay(auth.userId, query);

  return res.status(200).json({
    organizationId: day.organizationId,
    employmentId: day.employmentId,
    userId: day.userId,
    businessDate: day.businessDate,
    timezone: day.timezone,
    sessions: day.sessions.map(presentSession),
  });
};
