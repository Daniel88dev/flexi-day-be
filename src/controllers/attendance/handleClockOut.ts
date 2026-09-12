import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { beginAttendanceWrite, clockOut } from "../../services/attendance/attendanceServices.js";
import { attendanceScopeOfBody, presentSession } from "./utils.js";

export const handleClockOut = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const organizationId = attendanceScopeOfBody(req);

  const session = await db.transaction(async (tx) => {
    const subject = await beginAttendanceWrite(auth.userId, organizationId, tx);
    return clockOut(subject, auth.userId, tx);
  });

  return res.status(200).json(presentSession(session));
};
