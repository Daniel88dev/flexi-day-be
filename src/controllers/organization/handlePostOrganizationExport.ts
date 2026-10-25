import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { requestOrganizationExport } from "../../services/personExport/organizationExportServices.js";
import {
  assertExportStoreConfigured,
  presentPersonExport,
} from "../../services/personExport/personExportServices.js";
import { enqueuePersonExport } from "../../services/personExport/personExportQueue.js";
import {
  assertOrganizationOwner,
  ORGANIZATION_EXPORT_OWNER_ONLY,
  resolveAdministeredOrganization,
} from "./utils.js";

export const handlePostOrganizationExport = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { organization } = await resolveAdministeredOrganization(req);
  assertOrganizationOwner(organization, auth.userId, ORGANIZATION_EXPORT_OWNER_ONLY);
  assertExportStoreConfigured();

  const { row, created } = await db.transaction((tx) =>
    requestOrganizationExport(
      { organizationId: organization.id, requestedByUserId: auth.userId },
      tx
    )
  );

  if (created) enqueuePersonExport(row.id);
  return res.status(202).json(presentPersonExport(row));
};
