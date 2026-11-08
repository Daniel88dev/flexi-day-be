import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { aiConnectionsLevel } from "../../db/schema/organization-schema.js";
import {
  readAiSettings,
  setAiConnectionsLevel,
} from "../../services/aiFeatures/aiSettingsServices.js";
import type { AiConnectionsLevelBody } from "../../services/aiFeatures/types.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handlePostAiConnectionsLevel = async (req: Request, res: Response) => {
  const actor = await aiSettingsActor(req);
  const { level } = req.body as AiConnectionsLevelBody;
  await db.transaction((tx) =>
    setAiConnectionsLevel(
      {
        ...actor,
        level: level === "write" ? aiConnectionsLevel.Write : aiConnectionsLevel.Read,
      },
      tx
    )
  );
  res
    .status(200)
    .json(
      await readAiSettings({ organizationId: actor.organizationId, viewerUserId: actor.userId })
    );
};
