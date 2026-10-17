import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertGroupEventsActive } from "../../services/billing/guards.js";
import { loadGroupForGroupEvents } from "../../services/groupEvent/groupEventAccess.js";
import {
  canEditGroupEvent,
  insertGroupEvent,
  toGroupEventView,
} from "../../services/groupEvent/groupEventServices.js";
import type { CreateGroupEventBody } from "../../services/groupEvent/types.js";

export const handlePostGroupEvent = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as CreateGroupEventBody;

  const { event, groupName, access } = await db.transaction(async (tx) => {
    const { group, access } = await loadGroupForGroupEvents(auth.userId, body.groupId, tx);
    await assertGroupEventsActive(group.id, tx);
    const event = await insertGroupEvent(
      { id: generateRandomUUID(), createdByUserId: auth.userId, ...body },
      tx
    );
    return { event, groupName: group.groupName, access };
  });

  return res.status(201).json(
    toGroupEventView(event, {
      groupName,
      creator: { id: auth.userId, name: auth.userName },
      canEdit: canEditGroupEvent(event, auth.userId, access),
    })
  );
};
