import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { clockOutOwn } from "../../services/attendance/ownAttendance.js";
import { attendanceScopeOfBody, presentSession } from "./utils.js";

export const handleClockOut = async (req: Request, res: Response) => {
  const session = await clockOutOwn({
    auth: getAuth(req),
    organizationId: attendanceScopeOfBody(req),
  });

  return res.status(200).json(presentSession(session));
};
