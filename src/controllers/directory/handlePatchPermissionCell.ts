import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { changePermissionCell } from "../../services/directory/directoryPermissionServices.js";
import { loadDirectoryViewer } from "../../services/directory/directoryViewer.js";
import type { PatchPermissionCell } from "../../services/directory/types.js";
import { requirePathParam } from "../attendance/utils.js";

export const handlePatchPermissionCell = async (req: Request, res: Response) => {
  const organizationId = requirePathParam(req.params.organizationId, "organization id");
  const change = req.body as PatchPermissionCell;
  const table = await db.transaction(async (tx) => {
    const viewer = await loadDirectoryViewer(getAuth(req).userId, organizationId, tx);
    return changePermissionCell(viewer, change, tx);
  });
  return res.status(200).json(table);
};
