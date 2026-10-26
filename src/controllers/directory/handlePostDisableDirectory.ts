import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import {
  disableDirectory,
  readDirectoryState,
} from "../../services/directory/directorySettingsServices.js";
import { resolveOwnedDirectoryOrganization } from "./directoryOwner.js";

export const handlePostDisableDirectory = async (req: Request, res: Response) => {
  const { organization, userId } = await resolveOwnedDirectoryOrganization(req);

  const state = await db.transaction(async (tx) => {
    await disableDirectory({ organizationId: organization.id, userId }, tx);
    return readDirectoryState(organization.id, tx);
  });
  return res.status(200).json({ ...state, isOwner: true });
};
