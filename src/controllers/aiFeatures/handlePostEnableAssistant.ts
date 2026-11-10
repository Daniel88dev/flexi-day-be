import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { enableAssistant, readAiSettings } from "../../services/aiFeatures/aiSettingsServices.js";
import { notificationType } from "../../db/schema/notification-schema.js";
import { sendMemberNotices } from "../../services/aiFeatures/memberNotices.js";
import type { EnableAssistantBody } from "../../services/aiFeatures/types.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handlePostEnableAssistant = async (req: Request, res: Response) => {
  const actor = await aiSettingsActor(req);
  const { agreementVersion, tellMembers } = req.body as EnableAssistantBody;
  const notices = await db.transaction((tx) =>
    enableAssistant({ ...actor, agreementVersion, tellMembers: tellMembers ?? false }, tx)
  );
  await sendMemberNotices(notificationType.AssistantEnabled, actor.organizationId, notices);
  res
    .status(200)
    .json(
      await readAiSettings({ organizationId: actor.organizationId, viewerUserId: actor.userId })
    );
};
