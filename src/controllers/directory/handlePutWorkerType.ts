import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { changeWorkerType } from "../../services/directory/directoryWorkerTypeServices.js";
import type { PutWorkerType } from "../../services/directory/types.js";
import { requirePathParam } from "../attendance/utils.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePutWorkerType = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");

  const profile = await db.transaction(async (tx) =>
    changeWorkerType(await directoryViewerFor(req, tx), employmentId, req.body as PutWorkerType, tx)
  );
  return res.status(200).json(profile);
};
