import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { turnTargetOff } from "../../services/calendarConnection/calendarConnectionServices.js";
import { parseConfigId } from "./utils.js";

/** Turns direct sync off for one config and removes the events it wrote. */
export const handleDeleteTarget = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = parseConfigId(req.params.id);

  await turnTargetOff(id, auth.userId);

  return res.status(200).json({ message: "Direct sync turned off" });
};
