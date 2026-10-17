import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { upsertPushRegistration } from "../../services/pushRegistration/pushRegistrationServices.js";
import type { PutPushRegistrationBody } from "../../services/pushRegistration/types.js";

export const handlePutPushRegistration = async (req: Request, res: Response) => {
  const session = getAuth(req);
  const body = req.body as PutPushRegistrationBody;
  await db.transaction((tx) => upsertPushRegistration(session.sessionId, body, tx));
  return res.status(204).end();
};
