import express from "express";
import * as Sentry from "@sentry/node";
import { serverCors } from "./middleware/cors.js";
import { helmetHeaders } from "./middleware/headers.js";
import { limiter } from "./middleware/limiter.js";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./utils/auth.js";
import { config } from "./config.js";
import { errorMiddleware } from "./middleware/errorMiddleware.js";
import { vacationRouter } from "./routes/vacationRouter.js";
import { authSession } from "./middleware/authSession.js";
import { groupRouter } from "./routes/groupRouter.js";
import { groupUsersRouter } from "./routes/groupUsersRouter.js";
import { quotasRouter } from "./routes/quotasRouter.js";
import { authExtRouter } from "./routes/authExtRouter.js";
import { usersRouter } from "./routes/usersRouter.js";
import { bankHolidayRouter } from "./routes/bankHolidayRouter.js";
import { notificationRouter } from "./routes/notificationRouter.js";
import { calendarSyncRouter } from "./routes/calendarSyncRouter.js";
import { reportRouter } from "./routes/reportRouter.js";
import { tryCatch } from "./middleware/tryCatch.js";
import { handleGetCalendarFeed } from "./controllers/calendarSync/handleGetCalendarFeed.js";
import { devRouter } from "./routes/devRouter.js";
import { requestContext } from "./middleware/requestContext.js";

export const createServer = () => {
  const app = express();
  // `requestContext` sits ahead of every route, including better-auth's catch-all.
  app.set("trust proxy", 1).use(serverCors).use(requestContext).use(helmetHeaders).use(limiter);

  // Project-specific auth orchestration endpoints. These must be registered
  // BEFORE better-auth's catch-all `.all()` so the catch-all does not swallow
  // them. They need JSON body parsing, scoped tightly so the raw body that
  // better-auth itself needs is left untouched on its own paths.
  app.use("/api/auth/sign-up-with-team", express.json());
  app.use("/api/auth", authExtRouter());

  app.all("/api/auth/{*any}", toNodeHandler(auth)).use(express.json());

  // Local seeding/impersonation routes. `config.dev` is undefined unless the
  // environment explicitly opts in on a local database, so in every deployed
  // environment this branch never runs and the routes simply do not exist.
  if (config.dev) {
    app.use("/api/dev", devRouter());
  }

  app.use("/api/vacation", authSession, vacationRouter());
  app.use("/api/group", authSession, groupRouter());
  app.use("/api/group-user", authSession, groupUsersRouter());
  app.use("/api/quotas", authSession, quotasRouter());
  app.use("/api/users", authSession, usersRouter());
  app.use("/api/bank-holidays", authSession, bankHolidayRouter());
  app.use("/api/notifications", authSession, notificationRouter());
  app.use("/api/calendar-sync", authSession, calendarSyncRouter());
  app.use("/api/reports", authSession, reportRouter());

  // Public, token-authenticated iCalendar feed. Deliberately NOT behind
  // `authSession`: calendar clients subscribe with just the secret token in
  // the URL and cannot send session cookies.
  app.get("/calendars/:token.ics", tryCatch(handleGetCalendarFeed));

  app.get("/health", (_, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, environment: config.api.env });
  });

  // Must come after all routes and before errorMiddleware. Reports 5xx; 4xx
  // CustomErrors fall through to errorMiddleware.
  Sentry.setupExpressErrorHandler(app);

  app.use(errorMiddleware);

  return app;
};
