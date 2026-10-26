import type { Request, Response } from "express";
import { endPreview } from "../../services/directory/directoryEndPreview.js";
import { requirePathParam } from "../attendance/utils.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetEndPreview = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await endPreview(viewer, employmentId));
};
