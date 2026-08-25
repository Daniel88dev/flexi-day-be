import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { feedBaseUrl, serializeConfig } from "./utils.js";
import { getCalendarSyncForUser } from "../../services/calendarSync/calendarSyncServices.js";

/** Lists the caller's calendar-sync configs. Feed tokens are masked. */
export const handleGetCalendars = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const configs = await getCalendarSyncForUser(auth.userId);

  const baseUrl = feedBaseUrl(req);
  return res.status(200).json(configs.map((c) => serializeConfig(c, baseUrl, false)));
};
