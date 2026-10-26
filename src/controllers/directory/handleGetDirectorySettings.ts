import type { Request, Response } from "express";
import { resolveAdministeredOrganization } from "../organization/utils.js";
import { readDirectoryState } from "../../services/directory/directorySettingsServices.js";

export const handleGetDirectorySettings = async (req: Request, res: Response) => {
  const { organization, isOwner } = await resolveAdministeredOrganization(req);
  const state = await readDirectoryState(organization.id);
  return res.status(200).json({
    ...state,
    agreement: { ...state.agreement, newVersionReady: isOwner && state.agreement.newVersionReady },
    isOwner,
  });
};
