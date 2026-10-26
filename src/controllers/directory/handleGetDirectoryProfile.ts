import type { Request, Response } from "express";
import { getDirectoryProfile } from "../../services/directory/directoryProfileServices.js";
import { requirePathParam } from "../attendance/utils.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetDirectoryProfile = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await getDirectoryProfile(viewer, employmentId));
};
