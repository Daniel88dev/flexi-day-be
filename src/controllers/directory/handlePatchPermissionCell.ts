import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { changePermissionCell } from "../../services/directory/directoryPermissionServices.js";
import type { PatchPermissionCell } from "../../services/directory/types.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePatchPermissionCell = async (req: Request, res: Response) => {
  const change = req.body as PatchPermissionCell;
  const table = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return changePermissionCell(viewer, change, tx);
  });
  return res.status(200).json(table);
};
