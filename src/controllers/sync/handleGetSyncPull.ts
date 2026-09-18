import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { decodeSyncCursor } from "../../services/sync/syncCursor.js";
import { buildSyncDelta, buildSyncSnapshot } from "../../services/sync/syncServices.js";

// A cursor the server cannot use answers with a snapshot rather than an error,
// so `cursor` is never rejected: missing, unreadable, of another version or
// older than the expiry window all mean the same sync reset.
export const handleGetSyncPull = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const cursorTime = new Date();
  const sent = req.query.cursor;
  const cursor = typeof sent === "string" ? decodeSyncCursor(sent, cursorTime) : null;

  const envelope =
    cursor === null
      ? await buildSyncSnapshot(auth.userId, cursorTime)
      : await buildSyncDelta(auth.userId, cursor.cursorTime, cursorTime);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(envelope);
};
