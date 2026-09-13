import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getTeamAttendance } from "../../services/attendance/attendanceTeamServices.js";
import { validateAttendanceTeamQuery } from "../../services/attendance/types.js";
import { presentAttendanceTeam } from "./utils.js";

export const handleGetTeamAttendance = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const query = validateAttendanceTeamQuery.parse(req.query);
  const team = await getTeamAttendance(auth.userId, query);

  return res.status(200).json(presentAttendanceTeam(team));
};
