import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetUserQuota } from "../controllers/quotas/handleGetUserQuota.js";

export const quotasRouter = (): Router => {
  const app = Router();

  app.get("/:groupId", tryCatch(handleGetUserQuota));

  return app;
};
