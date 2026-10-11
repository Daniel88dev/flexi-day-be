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
  handlePostDevSignInTicket,
  validatePostDevSignInTicket,
} from "../controllers/dev/handlePostDevSignInTicket.js";
import {
  handlePostDevScenario,
  validatePostDevScenario,
} from "../controllers/dev/handlePostDevScenario.js";
import { handlePostDevReset } from "../controllers/dev/handlePostDevReset.js";
import {
  handlePostDevSetPlan,
  validatePostDevSetPlan,
} from "../controllers/dev/handlePostDevSetPlan.js";
import {
  handlePostDevCalendarConnect,
  validatePostDevCalendarConnect,
} from "../controllers/dev/handlePostDevCalendarConnect.js";
import { handleGetDevCalendarEvents } from "../controllers/dev/handleGetDevCalendarEvents.js";
import {
  handlePostDevCalendarCapability,
  validatePostDevCalendarCapability,
} from "../controllers/dev/handlePostDevCalendarCapability.js";

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
    "/sign-in-ticket",
    bodyValidationMiddleware(validatePostDevSignInTicket),
    tryCatch(handlePostDevSignInTicket)
  );

  app.post(
    "/scenario",
    bodyValidationMiddleware(validatePostDevScenario),
    tryCatch(handlePostDevScenario)
  );

  app.post("/reset", tryCatch(handlePostDevReset));

  app.post(
    "/billing/set-plan",
    bodyValidationMiddleware(validatePostDevSetPlan),
    tryCatch(handlePostDevSetPlan)
  );

  app.post(
    "/calendar/connect",
    bodyValidationMiddleware(validatePostDevCalendarConnect),
    tryCatch(handlePostDevCalendarConnect)
  );

  app.get("/calendar/events", tryCatch(handleGetDevCalendarEvents));

  app.post(
    "/calendar/capability",
    bodyValidationMiddleware(validatePostDevCalendarCapability),
    tryCatch(handlePostDevCalendarCapability)
  );

  return app;
};
