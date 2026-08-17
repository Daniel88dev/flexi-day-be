import type { Request } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import type { OrganizationType } from "../../services/organization/types.js";

const services = createDBServices();

/**
 * The organization to act on when the request names none: the caller's own.
 * A delegated admin who owns nothing gets a default only when they administer
 * exactly one — with several there is no sensible pick, and silently taking
 * the oldest would let an unqualified `PATCH` rename the wrong organization.
 */
const resolveDefaultOrganization = async (userId: string) => {
  const administered = await services.organization.getAdminOrganizationsForUser(userId);
  const owned = administered.find((organization) => organization.ownerUserId === userId);
  if (owned) return owned;

  if (administered.length > 1) {
    throw new AppError({
      message: "Name the organization to act on",
      logging: true,
      code: 400,
      context: { userId, administered: administered.length },
    });
  }

  return administered[0];
};

/**
 * Resolves the organization the request is about and checks the caller
 * administers it. `organizationId` may be omitted, in which case the caller's
 * own organization is used — most people have exactly one.
 */
export const resolveAdministeredOrganization = async (
  req: Request
): Promise<{ organization: OrganizationType; isOwner: boolean }> => {
  const auth = getAuth(req);

  const organizationId = z.string().min(1).optional().parse(req.query.organizationId);

  const organization = organizationId
    ? await services.organization.getOrganizationById(organizationId)
    : await resolveDefaultOrganization(auth.userId);

  if (!organization) {
    throw new AppError({
      message: "Organization not found",
      logging: true,
      code: 404,
      context: { userId: auth.userId, organizationId },
    });
  }

  const isAdmin = await services.organization.isOrganizationAdmin(auth.userId, organization.id);
  if (!isAdmin) {
    throw new AppError({
      message: "No permission for related organization",
      logging: true,
      code: 403,
      context: { userId: auth.userId, organizationId: organization.id },
    });
  }

  return { organization, isOwner: organization.ownerUserId === auth.userId };
};

/** Throws 403 unless the caller owns the organization — billing-adjacent writes are owner-only. */
export const assertOrganizationOwner = (organization: OrganizationType, userId: string): void => {
  if (organization.ownerUserId !== userId) {
    throw new AppError({
      message: "Only the organization owner can perform this action",
      logging: true,
      code: 403,
      context: { userId, organizationId: organization.id },
    });
  }
};
