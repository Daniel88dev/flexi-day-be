import type { Request, Response } from "express";
import { readDirectoryChecklist } from "../../services/directory/directoryChecklistServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetDirectoryChecklist = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await readDirectoryChecklist(viewer));
};
