import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { updateTargetTimeZone } from "../../services/calendarConnection/calendarConnectionServices.js";
import type { ValidatedUpdateCalendarTarget } from "../../services/calendarConnection/types.js";
import { serializeOwnedConfig } from "../calendarSync/utils.js";
import { parseConfigId } from "./utils.js";

/** Changes the time zone a target writes in and marks it due. */
export const handlePutTarget = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = parseConfigId(req.params.id);
  const body = req.body as ValidatedUpdateCalendarTarget;

  await updateTargetTimeZone(id, auth.userId, body.timeZone);

  return res.status(200).json(await serializeOwnedConfig(req, id, auth.userId));
};
