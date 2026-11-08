import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { disconnectGrant } from "../../services/aiConnections/grants.js";

export const handleDeleteMyAiConnection = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  await disconnectGrant({ userId, grantId: String(req.params.grantId) });
  res.status(204).send();
};
