import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { devGuard } from "../middleware/devGuard.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { handleGetDevStatus } from "../controllers/dev/handleGetDevStatus.js";
import { handlePostDevUser, validatePostDevUser } from "../controllers/dev/handlePostDevUser.js";
import {
  handlePostDevSession,
  validatePostDevSession,
} from "../controllers/dev/handlePostDevSession.js";
import {
  handlePostDevScenario,
  validatePostDevScenario,
} from "../controllers/dev/handlePostDevScenario.js";
import { handlePostDevReset } from "../controllers/dev/handlePostDevReset.js";

/**
 * Local-only seeding and impersonation surface, mounted by `server.ts` only
 * when `config.dev` exists (see `parseDevTools` for the environment gates).
 * `devGuard` additionally requires a loopback peer and the shared dev token on
 * every request. These routes are deliberately absent from the public API docs.
 */
export const devRouter = (): Router => {
  const app = Router();

  app.use(devGuard);

  app.get("/status", tryCatch(handleGetDevStatus));

  app.post("/users", bodyValidationMiddleware(validatePostDevUser), tryCatch(handlePostDevUser));

  app.post(
    "/session",
    bodyValidationMiddleware(validatePostDevSession),
    tryCatch(handlePostDevSession)
  );

  app.post(
    "/scenario",
    bodyValidationMiddleware(validatePostDevScenario),
    tryCatch(handlePostDevScenario)
  );

  app.post("/reset", tryCatch(handlePostDevReset));

  return app;
};
