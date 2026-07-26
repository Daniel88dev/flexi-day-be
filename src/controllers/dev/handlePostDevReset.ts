import type { Request, Response } from "express";
import { resetDevData } from "../../services/dev/devSeedServices.js";
import { logger } from "../../middleware/logger.js";

export const handlePostDevReset = async (_req: Request, res: Response) => {
  const summary = await resetDevData();
  logger.info("dev reset completed", summary);

  return res.status(200).json({ deleted: summary });
};
