import type { Request, Response } from "express";
import { getOrganizationDetailForSupport } from "../../services/support/supportServices.js";
import AppError from "../../utils/appError.js";

export const handleGetOrganizationDetail = async (req: Request, res: Response) => {
  const organizationId = req.params.organizationId ?? "";
  const detail = await getOrganizationDetailForSupport(organizationId);

  if (!detail) {
    throw new AppError({
      message: "Organization not found",
      code: 404,
      logging: true,
      context: { organizationId: req.params.organizationId },
    });
  }

  return res.status(200).json(detail);
};
