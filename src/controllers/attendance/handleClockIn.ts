import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { clockInOwn } from "../../services/attendance/ownAttendance.js";
import { attendanceScopeOfBody, presentSession } from "./utils.js";

export const handleClockIn = async (req: Request, res: Response) => {
  const session = await clockInOwn({
    auth: getAuth(req),
    organizationId: attendanceScopeOfBody(req),
  });

  return res.status(201).json(presentSession(session));
};
