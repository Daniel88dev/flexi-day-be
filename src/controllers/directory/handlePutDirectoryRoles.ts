import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { setDirectoryRoles } from "../../services/directory/directoryPermissionServices.js";
import type { PutDirectoryRoles } from "../../services/directory/types.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePutDirectoryRoles = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const { roles } = req.body as PutDirectoryRoles;
  const result = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return setDirectoryRoles(viewer, employmentId, roles, tx);
  });
  return res.status(200).json(result);
};
