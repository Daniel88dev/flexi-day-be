import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { notificationType } from "../../db/schema/notification-schema.js";
import { aiConnectionsLevel } from "../../db/schema/organization-schema.js";
import {
  enableAiConnections,
  readAiSettings,
} from "../../services/aiFeatures/aiSettingsServices.js";
import { sendMemberNotices } from "../../services/aiFeatures/memberNotices.js";
import type { EnableAiConnectionsBody } from "../../services/aiFeatures/types.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handlePostEnableAiConnections = async (req: Request, res: Response) => {
  const actor = await aiSettingsActor(req);
  const { level, agreementVersion, tellMembers } = req.body as EnableAiConnectionsBody;
  const notices = await db.transaction((tx) =>
    enableAiConnections(
      {
        ...actor,
        level: level === "write" ? aiConnectionsLevel.Write : aiConnectionsLevel.Read,
        agreementVersion,
        tellMembers: tellMembers ?? false,
      },
      tx
    )
  );
  await sendMemberNotices(notificationType.AiConnectionsEnabled, actor.organizationId, notices);
  res
    .status(200)
    .json(
      await readAiSettings({ organizationId: actor.organizationId, viewerUserId: actor.userId })
    );
};
