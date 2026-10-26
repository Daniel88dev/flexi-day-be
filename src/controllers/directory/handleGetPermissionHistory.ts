import type { Request, Response } from "express";
import { listPermissionHistory } from "../../services/directory/directoryPermissionServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetPermissionHistory = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await listPermissionHistory(viewer));
};
