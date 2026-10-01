import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import {
  getDeletionBlockers,
  getDeletionConfirmation,
} from "../../services/accountDeletion/accountDeletionServices.js";
import type { DeletionStatus } from "../../services/accountDeletion/types.js";

export const handleGetMyDeletion = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const blockers = await getDeletionBlockers(auth.userId);
  const confirmation = await getDeletionConfirmation(auth.userId);

  const status: DeletionStatus = { canDelete: blockers.length === 0, blockers, confirmation };
  return res.status(200).json(status);
};
