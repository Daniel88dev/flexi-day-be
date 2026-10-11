import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { config } from "../../config.js";
import { listConnections } from "../../services/calendarConnection/calendarConnectionServices.js";

/** The caller's calendar connections and which providers can be connected right now. */
export const handleGetConnections = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const connections = await listConnections(auth.userId);

  return res.status(200).json({
    providers: {
      google: config.calendarSync?.googleEnabled ?? false,
      microsoft: config.calendarSync?.microsoftEnabled ?? false,
    },
    connections,
  });
};
