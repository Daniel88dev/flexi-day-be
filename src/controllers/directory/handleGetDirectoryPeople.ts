import type { Request, Response } from "express";
import { listDirectoryPeople } from "../../services/directory/directoryPeopleServices.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetDirectoryPeople = async (req: Request, res: Response) => {
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await listDirectoryPeople(viewer));
};
