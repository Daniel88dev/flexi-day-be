import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import type { ValidatedPatchOrganizationType } from "../../services/organization/types.js";
import { assertOrganizationOwner, resolveAdministeredOrganization } from "./utils.js";
import { updateOrganization } from "../../services/organization/organizationServices.js";

/**
 * Renames the organization, or repoints the billing address. The name is
 * editable by any org admin; `billingEmail` is owner-only — it is where the
 * subscription grace warnings go.
 */
export const handlePatchOrganization = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPatchOrganizationType = req.body;

  const { organization } = await resolveAdministeredOrganization(req);

  if (data.billingEmail !== undefined) {
    assertOrganizationOwner(organization, auth.userId);
  }

  const updated = await updateOrganization(organization.id, {
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.billingEmail !== undefined ? { billingEmail: data.billingEmail } : {}),
  });

  if (!updated) {
    throw new AppError({
      message: "Organization not found",
      logging: true,
      code: 404,
      context: { userId: auth.userId, organizationId: organization.id },
    });
  }

  const isOwner = updated.ownerUserId === auth.userId;

  return res.status(200).json({
    id: updated.id,
    name: updated.name,
    isOwner,
    billingEmail: isOwner ? updated.billingEmail : null,
  });
};
