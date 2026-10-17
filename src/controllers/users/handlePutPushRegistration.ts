import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { assertNativeSession } from "../../utils/nativeSession.js";
import { upsertPushRegistration } from "../../services/pushRegistration/pushRegistrationServices.js";
import type { PutPushRegistrationBody } from "../../services/pushRegistration/types.js";

export const handlePutPushRegistration = async (req: Request, res: Response) => {
  const session = getAuth(req);
  assertNativeSession(session);

  await upsertPushRegistration(session.sessionId, req.body as PutPushRegistrationBody);
  return res.status(204).end();
};
