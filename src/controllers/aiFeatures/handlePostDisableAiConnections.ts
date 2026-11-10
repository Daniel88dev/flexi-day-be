import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import {
  disableAiConnections,
  readAiSettings,
} from "../../services/aiFeatures/aiSettingsServices.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handlePostDisableAiConnections = async (req: Request, res: Response) => {
  const actor = await aiSettingsActor(req);
  await db.transaction((tx) => disableAiConnections(actor, tx));
  res
    .status(200)
    .json(
      await readAiSettings({ organizationId: actor.organizationId, viewerUserId: actor.userId })
    );
};
