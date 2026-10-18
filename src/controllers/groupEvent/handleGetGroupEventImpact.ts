import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { planGroupEventEdit } from "../../services/groupEvent/editPlan.js";
import { loadEditableGroupEvent } from "../../services/groupEvent/groupEventAccess.js";
import {
  validateGroupEventId,
  validateGroupEventImpactQuery,
} from "../../services/groupEvent/types.js";

export const handleGetGroupEventImpact = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = validateGroupEventId.parse(req.params.id);
  const query = validateGroupEventImpactQuery.parse(req.query);

  // Plans inside a transaction only for the same locked read a PATCH makes; it writes nothing.
  const droppedOneOffs = await db.transaction(async (tx) => {
    const { event, oneOffs } = await loadEditableGroupEvent(auth.userId, id, tx);
    return planGroupEventEdit(event, oneOffs, query, generateRandomUUID).droppedOneOffs;
  });

  return res.status(200).json({ droppedOneOffs });
};
