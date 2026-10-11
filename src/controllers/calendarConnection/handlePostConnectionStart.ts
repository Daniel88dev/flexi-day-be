import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { startConnection } from "../../services/calendarConnection/calendarConnectionServices.js";
import type { ValidatedStartCalendarConnection } from "../../services/calendarConnection/types.js";
import { parseProvider } from "./utils.js";

/** Starts a consent round for one `ME` config and returns where to send the browser. */
export const handlePostConnectionStart = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const provider = parseProvider(req.params.provider);
  const body = req.body as ValidatedStartCalendarConnection;

  const url = await startConnection({
    userId: auth.userId,
    provider,
    configId: body.configId,
    timeZone: body.timeZone,
  });

  return res.status(200).json({ url });
};
