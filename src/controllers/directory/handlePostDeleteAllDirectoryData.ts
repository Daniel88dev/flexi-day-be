import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { logger } from "../../middleware/logger.js";
import {
  deleteAllDirectoryData,
  removeDeletedDirectoryObjects,
} from "../../services/directory/directoryDeleteAllServices.js";
import { readDirectoryState } from "../../services/directory/directorySettingsServices.js";
import type { DirectoryDeleteAllBody } from "../../services/directory/types.js";
import { resolveOwnedDirectoryOrganization } from "./directoryOwner.js";

export const handlePostDeleteAllDirectoryData = async (req: Request, res: Response) => {
  const { organization, userId } = await resolveOwnedDirectoryOrganization(req);
  const { confirmName } = req.body as DirectoryDeleteAllBody;

  const { deleted, state } = await db.transaction(async (tx) => {
    const deleted = await deleteAllDirectoryData(
      {
        organizationId: organization.id,
        organizationName: organization.name,
        confirmName,
        userId,
      },
      tx
    );
    return { deleted, state: await readDirectoryState(organization.id, tx) };
  });
  await removeDeletedDirectoryObjects(deleted);
  logger.info("directory.data_deleted", {
    organizationId: organization.id,
    userId,
    accountlessEmployments: deleted.accountlessEmployments,
    exports: deleted.exportKeys.length,
  });
  return res.status(200).json({ ...state, isOwner: true });
};
