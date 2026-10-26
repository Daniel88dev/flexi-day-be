import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { readPreviousSpell } from "../../services/directory/previousSpellServices.js";
import { requirePathParam } from "../attendance/utils.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetPreviousSpell = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const view = await db.transaction(async (tx) =>
    readPreviousSpell(await directoryViewerFor(req, tx), employmentId, tx)
  );
  return res.status(200).json(view);
};
