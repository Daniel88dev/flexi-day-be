import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getAiAvailabilityForUser } from "../../services/aiFeatures/aiFeatureServices.js";

export const handleGetAiAvailability = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  res.status(200).json(await getAiAvailabilityForUser(userId));
};
