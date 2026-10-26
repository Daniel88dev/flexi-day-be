import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { setRetentionHold } from "../../services/directory/retentionHoldServices.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePutRetentionHold = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const result = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx, { whileOff: true });
    return setRetentionHold(viewer, employmentId, tx);
  });
  return res.status(200).json(result);
};
