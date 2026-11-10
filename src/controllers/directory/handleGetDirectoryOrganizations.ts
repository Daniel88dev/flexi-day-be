import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { readDirectoryOrganizations } from "../../services/directory/directoryLookups.js";

export const handleGetDirectoryOrganizations = async (req: Request, res: Response) => {
  return res.status(200).json(await readDirectoryOrganizations({ auth: getAuth(req) }));
};
