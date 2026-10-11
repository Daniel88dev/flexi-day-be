import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { requestTargetSync } from "../../services/calendarConnection/calendarConnectionServices.js";
import { serializeOwnedConfig } from "../calendarSync/utils.js";
import { parseConfigId } from "./utils.js";

/** Sync now: queues the target and answers before the sync runs. */
export const handlePostTargetSync = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = parseConfigId(req.params.id);

  await requestTargetSync(id, auth.userId);

  return res.status(202).json(await serializeOwnedConfig(req, id, auth.userId));
};
