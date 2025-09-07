import express from "express";
import { serverCors } from "./middleware/cors.js";
import { helmetHeaders } from "./middleware/headers.js";
import { limiter } from "./middleware/limiter.js";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./utils/auth.js";
import { config } from "./config.js";

export const createServer = () => {
  const app = express();
  app
    .set("trust proxy", 1)
    .use(serverCors)
    .use(helmetHeaders)
    .use(limiter)
    .all("/api/auth/{*any}", toNodeHandler(auth))
    .use(express.json());

  app.get("/health", (_, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, environment: config.api.env });
  });

  return app;
};
