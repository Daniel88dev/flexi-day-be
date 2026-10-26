import type { Request, Response } from "express";
import { resolveAdministeredOrganization } from "../organization/utils.js";
import { readDirectoryState } from "../../services/directory/directorySettingsServices.js";

export const handleGetDirectorySettings = async (req: Request, res: Response) => {
  const { organization, isOwner } = await resolveAdministeredOrganization(req);
  return res.status(200).json({ ...(await readDirectoryState(organization.id)), isOwner });
};
