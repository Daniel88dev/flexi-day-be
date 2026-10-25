import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { isOrganizationAdmin } from "../../services/organization/organizationServices.js";
import { listRequestedExports } from "../../services/personExport/personExportServices.js";
import { validatePersonExportListQuery } from "../../services/personExport/types.js";
import AppError from "../../utils/appError.js";

export const handleGetRequestedExports = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { organizationId } = validatePersonExportListQuery.parse(req.query);
  if (!(await isOrganizationAdmin(auth.userId, organizationId))) {
    throw new AppError({
      code: 403,
      message: "No permission for related organization",
      logging: true,
      context: { userId: auth.userId, organizationId },
    });
  }
  return res.status(200).json(await listRequestedExports(auth.userId, organizationId));
};
