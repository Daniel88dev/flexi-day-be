import type { Request, Response } from "express";
import { readAiUsageWeek } from "../../services/aiFeatures/aiUsageServices.js";
import { validateUsageWeekStart } from "../../services/aiFeatures/types.js";
import AppError from "../../utils/appError.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handleGetAiUsageWeek = async (req: Request, res: Response) => {
  const { organizationId } = await aiSettingsActor(req);
  const weekStart = validateUsageWeekStart.safeParse(req.params.weekStart);
  if (!weekStart.success) {
    throw new AppError({ message: "weekStart must be a date (YYYY-MM-DD)", code: 422 });
  }
  res.status(200).json(await readAiUsageWeek(organizationId, weekStart.data));
};
