import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { disconnectProvider } from "../../services/calendarConnection/calendarConnectionServices.js";
import { parseProvider } from "./utils.js";

/** Disconnects a provider: every target's events go, then the token, then the row. */
export const handleDeleteConnection = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const provider = parseProvider(req.params.provider);

  await disconnectProvider(auth.userId, provider);

  return res.status(200).json({ message: "Calendar disconnected" });
};
