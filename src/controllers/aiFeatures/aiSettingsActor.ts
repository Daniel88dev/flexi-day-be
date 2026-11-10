import type { Request } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { resolveAdministeredOrganization } from "../organization/utils.js";

/** The administered organization the request names and the caller. The services check the owner. */
export const aiSettingsActor = async (req: Request) => {
  const { userId } = getAuth(req);
  const { organization } = await resolveAdministeredOrganization(req);
  return { organizationId: organization.id, userId };
};
