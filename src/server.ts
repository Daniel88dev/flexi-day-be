import express from "express";
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

export const createServer = () => {
  const app = express();
  app.set("trust proxy", 1).use(serverCors).use(helmetHeaders).use(limiter);

  // Project-specific auth orchestration endpoints. These must be registered
  // BEFORE better-auth's catch-all `.all()` so the catch-all does not swallow
  // them. They need JSON body parsing, scoped tightly so the raw body that
  // better-auth itself needs is left untouched on its own paths.
  app.use("/api/auth/sign-up-with-team", express.json());
  app.use("/api/auth", authExtRouter());

  app
    .all("/api/auth/{*any}", toNodeHandler(auth))
    .use(express.json());

  app.use("/api/vacation", authSession, vacationRouter());
  app.use("/api/group", authSession, groupRouter());
  app.use("/api/group-user", authSession, groupUsersRouter());
  app.use("/api/quotas", authSession, quotasRouter());
  app.use("/api/users", authSession, usersRouter());
  app.use("/api/bank-holidays", authSession, bankHolidayRouter());
  app.use("/api/notifications", authSession, notificationRouter());

  app.get("/health", (_, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, environment: config.api.env });
  });

  app.use(errorMiddleware);

  return app;
};
