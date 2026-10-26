import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { latestOrganizationExport } from "../../services/personExport/organizationExportServices.js";
import { presentPersonExport } from "../../services/personExport/personExportServices.js";
import { assertOrganizationExportOwner, resolveAdministeredOrganization } from "./utils.js";

export const handleGetOrganizationExport = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { organization } = await resolveAdministeredOrganization(req);
  assertOrganizationExportOwner(organization, auth.userId);

  const row = await latestOrganizationExport(organization.id, auth.userId);
  return res.status(200).json({ export: row ? presentPersonExport(row) : null });
};
