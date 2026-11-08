import type { Request, Response } from "express";
import { revokeOrganizationGrant } from "../../services/aiConnections/grants.js";
import { logger } from "../../middleware/logger.js";
import { requirePathParam } from "../pathParams.js";
import { aiSettingsActor } from "./aiSettingsActor.js";

export const handleDeleteOrganizationAiConnection = async (req: Request, res: Response) => {
  const { organizationId, userId } = await aiSettingsActor(req);
  const grantId = requirePathParam(req.params.grantId, "grant id");
  await revokeOrganizationGrant({ organizationId, grantId });
  logger.info("ai_connections.grant_revoked", { organizationId, grantId, byUserId: userId });
  res.status(204).end();
};
