import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { assertNativeSession } from "../../utils/nativeSession.js";
import { deletePushRegistration } from "../../services/pushRegistration/pushRegistrationServices.js";

export const handleDeletePushRegistration = async (req: Request, res: Response) => {
  const session = getAuth(req);
  assertNativeSession(session);

  await deletePushRegistration(session.sessionId);
  return res.status(204).end();
};
