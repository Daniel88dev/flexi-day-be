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

export const createServer = () => {
  const app = express();
  app
    .set("trust proxy", 1)
    .use(serverCors)
    .use(helmetHeaders)
    .use(limiter)
    .all("/api/auth/{*any}", toNodeHandler(auth))
    .use(express.json());

  app.use("/api/vacation", authSession, vacationRouter());
  app.use("/api/group", authSession, groupRouter());
  app.use("/api/group-user", authSession, groupUsersRouter());

  app.get("/health", (_, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, environment: config.api.env });
  });

  app.use(errorMiddleware);

  return app;
};
