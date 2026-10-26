import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { updateDirectoryProfile } from "../../services/directory/directoryProfileEditServices.js";
import type { PatchDirectoryProfile } from "../../services/directory/types.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePatchDirectoryProfile = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const patch = req.body as PatchDirectoryProfile;

  const profile = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return updateDirectoryProfile(viewer, employmentId, patch, tx);
  });
  return res.status(200).json(profile);
};
