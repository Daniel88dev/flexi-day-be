import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertGroupEventsActive } from "../../services/billing/guards.js";
import { planGroupEventEdit } from "../../services/groupEvent/editPlan.js";
import {
  groupEventViewsFor,
  loadEditableGroupEvent,
} from "../../services/groupEvent/groupEventAccess.js";
import { applyGroupEventPlan } from "../../services/groupEvent/groupEventServices.js";
import {
  validateGroupEventId,
  type GroupEventEditRequest,
  type GroupEventWriteResult,
} from "../../services/groupEvent/types.js";

export const handlePatchGroupEvent = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = validateGroupEventId.parse(req.params.id);
  const body = req.body as GroupEventEditRequest;

  const result: GroupEventWriteResult = await db.transaction(async (tx) => {
    const { event, oneOffs, ...standing } = await loadEditableGroupEvent(auth.userId, id, tx);
    const plan = planGroupEventEdit(event, oneOffs, body, generateRandomUUID);
    if (plan.splits) await assertGroupEventsActive(event.groupId, tx);
    const rows = await applyGroupEventPlan(plan, tx);
    return {
      droppedOneOffs: plan.droppedOneOffs,
      events: await groupEventViewsFor(auth.userId, standing, rows, tx),
      deletedIds: plan.tombstones,
    };
  });

  return res.status(200).json(result);
};
