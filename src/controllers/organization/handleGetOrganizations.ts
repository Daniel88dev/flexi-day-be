import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { getAdminOrganizationsForUser } from "../../services/organization/organizationServices.js";

/**
 * The organizations the caller owns or administers — owned first. Drives the
 * organization page's switcher for anyone who administers more than one.
 */
export const handleGetOrganizations = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const organizations = await getAdminOrganizationsForUser(auth.userId);

  return res.status(200).json(
    organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      isOwner: organization.ownerUserId === auth.userId,
    }))
  );
};
