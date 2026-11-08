import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { chooseConnectOrganization } from "../../services/aiConnections/connectContext.js";
import type { ConnectOrganizationBody } from "../../services/aiConnections/types.js";

export const handlePostConnectOrganization = async (req: Request, res: Response) => {
  const { userId, sessionId } = getAuth(req);
  const { organizationId } = req.body as ConnectOrganizationBody;
  res.status(200).json(await chooseConnectOrganization({ userId, sessionId, organizationId }));
};
