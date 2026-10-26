import type { Request, Response } from "express";
import { readPermissionTable } from "../../services/directory/directoryPermissionServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetPermissionTable = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await readPermissionTable(viewer));
};
