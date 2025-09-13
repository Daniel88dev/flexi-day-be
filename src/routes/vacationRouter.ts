import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetVacations } from "../controllers/vacation/handleGetVacations.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePostVacation } from "../services/vacation/types.js";
import { handlePostVacation } from "../controllers/vacation/handlePostVacation.js";

export const vacationRouter = (): Router => {
  const app = Router();

  app.get("/", tryCatch(handleGetVacations));

  app.post(
    "/",
    bodyValidationMiddleware(validatePostVacation),
    tryCatch(handlePostVacation)
  );

  return app;
};
