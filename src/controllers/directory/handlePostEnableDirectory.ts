import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import {
  planDirectoryEnabledNotices,
  sendDirectoryEnabledNotices,
} from "../../services/directory/directoryEnabledNotice.js";
import {
  enableDirectory,
  readDirectoryState,
} from "../../services/directory/directorySettingsServices.js";
import type { EnableDirectoryBody } from "../../services/directory/types.js";
import { resolveOwnedDirectoryOrganization } from "./directoryOwner.js";

export const handlePostEnableDirectory = async (req: Request, res: Response) => {
  const { organization, userId } = await resolveOwnedDirectoryOrganization(req);
  const { agreementVersion, tellMembers } = req.body as EnableDirectoryBody;

  const { state, notices } = await db.transaction(async (tx) => {
    await enableDirectory({ organizationId: organization.id, userId, agreementVersion }, tx);
    return {
      state: await readDirectoryState(organization.id, tx),
      notices: tellMembers ? await planDirectoryEnabledNotices(organization.id, tx) : [],
    };
  });
  await sendDirectoryEnabledNotices(organization.id, notices);
  return res.status(200).json({ ...state, isOwner: true });
};
