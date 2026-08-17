import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import { assertOrganizationOwner, resolveAdministeredOrganization } from "./utils.js";

const services = createDBServices();

/**
 * Who may be promoted to organization admin: the members of the org's own
 * groups, minus its existing admins. Deliberately not a lookup by email —
 * that would let an owner probe whether any address has an account.
 */
export const handleGetOrganizationCandidates = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { organization } = await resolveAdministeredOrganization(req);
  assertOrganizationOwner(organization, auth.userId);

  const candidates = await services.organization.listOrganizationAdminCandidates(organization.id);

  return res.status(200).json(candidates);
};
