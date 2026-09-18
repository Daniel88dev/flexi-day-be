import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { buildSyncSnapshot } from "../../services/sync/syncServices.js";

// A cursor the server cannot use answers with a snapshot rather than an
// error, so `cursor` is never rejected — it is simply not read back yet.
export const handleGetSyncPull = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const envelope = await buildSyncSnapshot(auth.userId);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(envelope);
};
