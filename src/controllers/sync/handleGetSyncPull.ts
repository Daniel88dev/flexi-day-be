import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { decodeSyncCursor } from "../../services/sync/syncCursor.js";
import { buildSyncPull } from "../../services/sync/syncServices.js";

// A cursor the server cannot use answers with a snapshot rather than an error,
// so `cursor` is never rejected: missing, unreadable, of another version,
// older than the expiry window or carrying page state the walk cannot resume
// all mean the same sync reset.
export const handleGetSyncPull = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const cursorTime = new Date();
  const sent = req.query.cursor;
  const cursor = typeof sent === "string" ? decodeSyncCursor(sent, cursorTime) : null;

  const envelope = await buildSyncPull(auth.userId, cursor, cursorTime);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(envelope);
};
