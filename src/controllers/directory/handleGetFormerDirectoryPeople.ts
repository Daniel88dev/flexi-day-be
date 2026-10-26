import type { Request, Response } from "express";
import { listFormerDirectoryPeople } from "../../services/directory/directoryProfileServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetFormerDirectoryPeople = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await listFormerDirectoryPeople(viewer));
};
