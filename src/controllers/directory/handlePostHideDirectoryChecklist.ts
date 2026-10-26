import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { hideDirectoryChecklist } from "../../services/directory/directoryChecklistServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePostHideDirectoryChecklist = async (req: Request, res: Response) => {
  const checklist = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return hideDirectoryChecklist(viewer, tx);
  });
  return res.status(200).json(checklist);
};
