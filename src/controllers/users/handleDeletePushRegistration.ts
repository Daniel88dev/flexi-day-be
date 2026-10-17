import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { deletePushRegistration } from "../../services/pushRegistration/pushRegistrationServices.js";

export const handleDeletePushRegistration = async (req: Request, res: Response) => {
  const session = getAuth(req);
  await deletePushRegistration(session.sessionId);
  return res.status(204).end();
};
