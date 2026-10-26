import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { liftRetentionHold } from "../../services/directory/retentionHoldServices.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleDeleteRetentionHold = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const result = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx, { whileOff: true });
    return liftRetentionHold(viewer, employmentId, tx);
  });
  return res.status(200).json(result);
};
