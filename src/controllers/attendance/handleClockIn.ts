import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { beginAttendanceWrite, clockIn } from "../../services/attendance/attendanceServices.js";
import { attendanceScopeOfBody, presentSession } from "./utils.js";

/**
 * Starts a session at the server's instant, never the client's. The business
 * date is fixed here from the organization's zone and never moves again.
 */
export const handleClockIn = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const organizationId = attendanceScopeOfBody(req);

  const session = await db.transaction(async (tx) => {
    const subject = await beginAttendanceWrite(auth.userId, organizationId, tx);
    return clockIn(subject, auth.userId, tx);
  });

  return res.status(201).json(presentSession(session));
};
