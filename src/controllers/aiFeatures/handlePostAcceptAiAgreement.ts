import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { acceptAiAgreement, readAiSettings } from "../../services/aiFeatures/aiSettingsServices.js";
import type { AiAgreementBody } from "../../services/aiFeatures/types.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handlePostAcceptAiAgreement = async (req: Request, res: Response) => {
  const actor = await aiSettingsActor(req);
  const { agreementVersion } = req.body as AiAgreementBody;
  await db.transaction((tx) => acceptAiAgreement({ ...actor, agreementVersion }, tx));
  res
    .status(200)
    .json(
      await readAiSettings({ organizationId: actor.organizationId, viewerUserId: actor.userId })
    );
};
