import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { disableAssistant, readAiSettings } from "../../services/aiFeatures/aiSettingsServices.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handlePostDisableAssistant = async (req: Request, res: Response) => {
  const actor = await aiSettingsActor(req);
  await db.transaction((tx) => disableAssistant(actor, tx));
  res
    .status(200)
    .json(
      await readAiSettings({ organizationId: actor.organizationId, viewerUserId: actor.userId })
    );
};
