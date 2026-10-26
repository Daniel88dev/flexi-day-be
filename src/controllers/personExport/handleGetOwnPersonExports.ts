import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { listOwnExportOrganizations } from "../../services/personExport/personExportServices.js";

export const handleGetOwnPersonExports = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  return res.status(200).json({ organizations: await listOwnExportOrganizations(auth.userId) });
};
