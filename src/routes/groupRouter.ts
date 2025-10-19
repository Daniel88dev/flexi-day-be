import { Router } from "express";
import { handlePostGroup } from "../controllers/group/handlePostGroup.js";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetGroups } from "../controllers/group/handleGetGroups.js";

export const groupRouter = (): Router => {
  const app = Router();

  app.post("/", tryCatch(handlePostGroup));

  app.get("/", tryCatch(handleGetGroups));

  return app;
};
