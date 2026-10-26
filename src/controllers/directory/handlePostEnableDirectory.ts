import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import {
  enableDirectory,
  readDirectoryState,
} from "../../services/directory/directorySettingsServices.js";
import type { DirectoryAgreementBody } from "../../services/directory/types.js";
import { resolveOwnedDirectoryOrganization } from "./directoryOwner.js";

export const handlePostEnableDirectory = async (req: Request, res: Response) => {
  const { organization, userId } = await resolveOwnedDirectoryOrganization(req);
  const { agreementVersion } = req.body as DirectoryAgreementBody;

  const state = await db.transaction(async (tx) => {
    await enableDirectory({ organizationId: organization.id, userId, agreementVersion }, tx);
    return readDirectoryState(organization.id, tx);
  });
  return res.status(200).json({ ...state, isOwner: true });
};
