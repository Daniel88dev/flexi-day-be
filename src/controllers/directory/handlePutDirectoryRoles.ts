import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { setDirectoryRoles } from "../../services/directory/directoryPermissionServices.js";
import { loadDirectoryViewer } from "../../services/directory/directoryViewer.js";
import type { PutDirectoryRoles } from "../../services/directory/types.js";
import { requirePathParam } from "../attendance/utils.js";

export const handlePutDirectoryRoles = async (req: Request, res: Response) => {
  const organizationId = requirePathParam(req.params.organizationId, "organization id");
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const { roles } = req.body as PutDirectoryRoles;
  const result = await db.transaction(async (tx) => {
    const viewer = await loadDirectoryViewer(getAuth(req).userId, organizationId, tx);
    return setDirectoryRoles(viewer, employmentId, roles, tx);
  });
  return res.status(200).json(result);
};
