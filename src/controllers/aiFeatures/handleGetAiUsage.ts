import type { Request, Response } from "express";
import { readAiUsage } from "../../services/aiFeatures/aiUsageServices.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handleGetAiUsage = async (req: Request, res: Response) => {
  const { organizationId } = await aiSettingsActor(req);
  res.status(200).json(await readAiUsage(organizationId));
};
