import type { Request, Response } from "express";
import { listDirectoryRoles } from "../../services/directory/directoryPermissionServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetDirectoryRoles = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await listDirectoryRoles(viewer));
};
