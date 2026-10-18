import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { planGroupEventDelete } from "../../services/groupEvent/editPlan.js";
import {
  groupEventViewsFor,
  loadEditableGroupEvent,
} from "../../services/groupEvent/groupEventAccess.js";
import { applyGroupEventPlan } from "../../services/groupEvent/groupEventServices.js";
import {
  validateDeleteGroupEventQuery,
  validateGroupEventId,
  type GroupEventWriteResult,
} from "../../services/groupEvent/types.js";
import { markGroupEventTargetsDirty } from "../../services/calendarSync/markCalendarTargetsDirty.js";

export const handleDeleteGroupEvent = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = validateGroupEventId.parse(req.params.id);
  const query = validateDeleteGroupEventQuery.parse(req.query);

  const { groupId, ...result } = await db.transaction(async (tx) => {
    const { event, oneOffs, ...standing } = await loadEditableGroupEvent(auth.userId, id, tx);
    const plan = planGroupEventDelete(event, oneOffs, query);
    const rows = await applyGroupEventPlan(plan, tx);
    const written: GroupEventWriteResult & { groupId: string } = {
      groupId: event.groupId,
      droppedOneOffs: plan.droppedOneOffs,
      events: await groupEventViewsFor(auth.userId, standing, rows, tx),
      deletedIds: plan.tombstones,
    };
    return written;
  });
  await markGroupEventTargetsDirty(groupId);

  return res.status(200).json(result);
};
