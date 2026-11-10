import type { Request, Response } from "express";
import { config } from "../../config.js";
import { getAuth } from "../../middleware/authSession.js";
import { listUserGrants } from "../../services/aiConnections/grants.js";

export const handleGetMyAiConnections = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  res.status(200).json({
    serverUrl: `${config.api.publicUrl}/mcp`,
    connections: await listUserGrants(userId),
  });
};
