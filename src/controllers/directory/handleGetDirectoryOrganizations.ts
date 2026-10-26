import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { listDirectoryOrganizations } from "../../services/directory/directorySettingsServices.js";

export const handleGetDirectoryOrganizations = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  return res.status(200).json(await listDirectoryOrganizations(auth.userId));
};
