import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { assertOrganizationOwner, resolveAdministeredOrganization } from "./utils.js";
import {
  listOrganizationAdmins,
  lockOrganization,
  removeOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

/**
 * Revokes an org admin grant. Owner-only, and the owner's own rights cannot be
 * revoked.
 *
 * Takes the organization lock the grant path and `handleDeleteGroupUser`
 * already take. Revoking is one of the two link removals that can end an
 * Employment, and `handleDeleteGroupUser` performs both: without this lock the
 * two can interleave so that each sees the other's link as live, and the
 * membership transaction then finds the grant already gone, skips its own
 * recomputation, and leaves the Employment open with nothing holding it.
 */
export const handleDeleteOrganizationAdmin = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const userId = z.string().min(1).parse(req.params.userId);

  const { organization } = await resolveAdministeredOrganization(req);
  assertOrganizationOwner(organization, auth.userId);

  const removed = await db.transaction(async (tx) => {
    await lockOrganization(organization.id, tx);
    return removeOrganizationAdmin(organization.id, userId, tx);
  });

  if (!removed) {
    throw new AppError({
      message: "This user is not an administrator of this organization",
      logging: true,
      code: 404,
      context: { userId: auth.userId, organizationId: organization.id, target: userId },
    });
  }

  const admins = await listOrganizationAdmins(organization.id);

  return res.status(200).json(admins);
};
