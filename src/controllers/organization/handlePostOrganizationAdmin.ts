import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import type { ValidatedPostOrganizationAdminType } from "../../services/organization/types.js";
import { assertOrganizationOwner, resolveAdministeredOrganization } from "./utils.js";

const services = createDBServices();

/**
 * Promotes one of the organization's own people to org admin. Owner-only:
 * an admin who could appoint further admins would make the grant
 * self-propagating, and revoking the first one would no longer undo it.
 */
export const handlePostOrganizationAdmin = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostOrganizationAdminType = req.body;

  const { organization } = await resolveAdministeredOrganization(req);
  assertOrganizationOwner(organization, auth.userId);

  // The candidate list is the authorization boundary, not just the UI's menu:
  // it is what confines a grant to people already inside the organization.
  const candidates = await services.organization.listOrganizationAdminCandidates(organization.id);
  if (!candidates.some((candidate) => candidate.userId === data.userId)) {
    // The candidate list also excludes people who already administer the org,
    // so "not a member" would be a flatly wrong answer for them — which a
    // client hits whenever its list is stale after a concurrent grant.
    const admins = await services.organization.listOrganizationAdmins(organization.id);
    if (admins.some((admin) => admin.userId === data.userId)) {
      throw new AppError({
        message: "This user already administers this organization",
        logging: true,
        code: 409,
        context: { userId: auth.userId, organizationId: organization.id, target: data.userId },
      });
    }

    throw new AppError({
      message: "This user is not a member of any group in this organization",
      logging: true,
      code: 422,
      context: { userId: auth.userId, organizationId: organization.id, target: data.userId },
    });
  }

  await services.organization.grantOrganizationAdmin({
    organizationId: organization.id,
    userId: data.userId,
    grantedByUserId: auth.userId,
    // The check above is only the fast path; this is the one that counts,
    // because it runs under the organization lock that the revocation in
    // `handleDeleteGroupUser` also takes.
    assertStillEligible: (tx) =>
      services.groupUser
        .countActiveMembershipsInOrganization(data.userId, organization.id, tx)
        .then((count) => count > 0),
  });

  const admins = await services.organization.listOrganizationAdmins(organization.id);

  return res.status(201).json(admins);
};
