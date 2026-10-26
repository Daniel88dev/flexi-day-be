import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { removePhotoObjects } from "../../services/directory/directoryPhotoServices.js";
import { getDirectoryProfile } from "../../services/directory/directoryProfileServices.js";
import { copyFromPreviousSpell } from "../../services/directory/previousSpellServices.js";
import type { PostCopyPreviousSpell } from "../../services/directory/types.js";
import { requirePathParam } from "../attendance/utils.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePostCopyPreviousSpell = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const written: string[] = [];
  try {
    const profile = await db.transaction(async (tx) => {
      const viewer = await directoryViewerFor(req, tx);
      await copyFromPreviousSpell(
        viewer,
        employmentId,
        req.body as PostCopyPreviousSpell,
        tx,
        written
      );
      return getDirectoryProfile(viewer, employmentId, tx);
    });
    return res.status(200).json(profile);
  } catch (error) {
    await removePhotoObjects(written);
    throw error;
  }
};
