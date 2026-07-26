import type { Request, Response } from "express";
import { config } from "../../config.js";
import { countSeededUsers } from "../../services/dev/devSeedServices.js";

export const handleGetDevStatus = async (_req: Request, res: Response) => {
  const databaseHost = new URL(config.db.database).host;

  return res.status(200).json({
    ok: true,
    environment: config.api.env,
    port: config.api.port,
    databaseHost,
    seedEmailDomain: config.dev?.seedEmailDomain,
    seededUsers: await countSeededUsers(),
    appUrl: config.email.appUrl,
  });
};
