import type { Request } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { assertOrganizationOwner, resolveAdministeredOrganization } from "../organization/utils.js";

const DIRECTORY_OWNER_ONLY = {
  message: "Only the organization owner can change the directory",
  publicCode: "OWNER_ONLY",
};

/** The administered organization the request names, refused with 403 unless the caller owns it. */
export const resolveOwnedDirectoryOrganization = async (req: Request) => {
  const auth = getAuth(req);
  const { organization } = await resolveAdministeredOrganization(req);
  assertOrganizationOwner(organization, auth.userId, DIRECTORY_OWNER_ONLY);
  return { organization, userId: auth.userId };
};
