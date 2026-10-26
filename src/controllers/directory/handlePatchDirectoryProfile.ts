import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { updateDirectoryProfile } from "../../services/directory/directoryProfileEditServices.js";
import { loadDirectoryViewer } from "../../services/directory/directoryViewer.js";
import type { PatchDirectoryProfile } from "../../services/directory/types.js";
import { requirePathParam } from "../attendance/utils.js";

export const handlePatchDirectoryProfile = async (req: Request, res: Response) => {
  const organizationId = requirePathParam(req.params.organizationId, "organization id");
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const patch = req.body as PatchDirectoryProfile;

  const profile = await db.transaction(async (tx) => {
    const viewer = await loadDirectoryViewer(getAuth(req).userId, organizationId, tx);
    return updateDirectoryProfile(viewer, employmentId, patch, tx);
  });
  return res.status(200).json(profile);
};
