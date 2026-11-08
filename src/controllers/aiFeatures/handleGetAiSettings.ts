import type { Request, Response } from "express";
import { readAiSettings } from "../../services/aiFeatures/aiSettingsServices.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handleGetAiSettings = async (req: Request, res: Response) => {
  const { organizationId, userId } = await aiSettingsActor(req);
  res.status(200).json(await readAiSettings({ organizationId, viewerUserId: userId }));
};
