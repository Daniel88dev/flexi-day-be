import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { assertOrganizationOwner, resolveAdministeredOrganization } from "./utils.js";

const services = createDBServices();

/** Revokes an org admin grant. Owner-only, and the owner's own rights cannot be revoked. */
export const handleDeleteOrganizationAdmin = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const userId = z.string().min(1).parse(req.params.userId);

  const { organization } = await resolveAdministeredOrganization(req);
  assertOrganizationOwner(organization, auth.userId);

  const removed = await services.organization.removeOrganizationAdmin(organization.id, userId);

  if (!removed) {
    throw new AppError({
      message: "This user is not an administrator of this organization",
      logging: true,
      code: 404,
      context: { userId: auth.userId, organizationId: organization.id, target: userId },
    });
  }

  const admins = await services.organization.listOrganizationAdmins(organization.id);

  return res.status(200).json(admins);
};
