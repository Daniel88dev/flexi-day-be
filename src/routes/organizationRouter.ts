import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validatePatchOrganization,
  validatePostOrganizationAdmin,
} from "../services/organization/types.js";
import { handleGetOrganization } from "../controllers/organization/handleGetOrganization.js";
import { handleGetOrganizations } from "../controllers/organization/handleGetOrganizations.js";
import { handlePatchOrganization } from "../controllers/organization/handlePatchOrganization.js";
import { handleGetOrganizationCandidates } from "../controllers/organization/handleGetOrganizationCandidates.js";
import { handlePostOrganizationAdmin } from "../controllers/organization/handlePostOrganizationAdmin.js";
import { handleDeleteOrganizationAdmin } from "../controllers/organization/handleDeleteOrganizationAdmin.js";

export const organizationRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/organization/list:
   *   get:
   *     tags:
   *       - Organization
   *     summary: Organizations the caller owns or administers
   *     description: |
   *       Owned organizations come first. Drives the organization page's
   *       switcher for anyone who administers more than one. Returns an empty
   *       array for a user with no organization yet.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Array of `{ id, name, isOwner }`
   */
  app.get("/list", tryCatch(handleGetOrganizations));

  /**
   * @openapi
   * /api/organization:
   *   get:
   *     tags:
   *       - Organization
   *     summary: Organization detail — plan, groups and administrators
   *     description: |
   *       Defaults to the caller's own organization; pass `organizationId` to
   *       address one they administer but do not own. Delegated admins see the
   *       plan and its limits but not the billing address — `billingEmail` is
   *       null for them, and subscription detail stays on
   *       `/api/billing/subscription`, which resolves by ownership.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Organization, plan, groups, administrators
   *       '400':
   *         description: |
   *           `organizationId` omitted by a delegated admin who owns none and
   *           administers several — there is no unambiguous default.
   *       '403':
   *         description: Caller does not administer this organization
   *       '404':
   *         description: No such organization, or the caller has none yet
   */
  app.get("/", tryCatch(handleGetOrganization));

  /**
   * @openapi
   * /api/organization:
   *   patch:
   *     tags:
   *       - Organization
   *     summary: Rename the organization or repoint its billing address
   *     description: |
   *       The name is editable by any organization admin. `billingEmail` is
   *       owner-only — it is where subscription grace warnings are sent.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 120
   *               billingEmail:
   *                 type: string
   *                 format: email
   *     responses:
   *       '200':
   *         description: The updated organization
   *       '400':
   *         description: |
   *           No field to update, or `organizationId` omitted by a delegated
   *           admin who administers several organizations.
   *       '403':
   *         description: Not an admin, or not the owner for `billingEmail`
   *       '404':
   *         description: Organization not found
   */
  app.patch(
    "/",
    bodyValidationMiddleware(validatePatchOrganization),
    tryCatch(handlePatchOrganization)
  );

  /**
   * @openapi
   * /api/organization/candidates:
   *   get:
   *     tags:
   *       - Organization
   *     summary: People who may be promoted to organization admin
   *     description: |
   *       Active members of the organization's live groups, minus its existing
   *       administrators. Owner-only. Deliberately not a lookup by email —
   *       that would let an owner probe whether an address has an account.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Array of candidates with the groups they belong to
   *       '403':
   *         description: Caller is not the organization owner
   */
  app.get("/candidates", tryCatch(handleGetOrganizationCandidates));

  /**
   * @openapi
   * /api/organization/admins:
   *   post:
   *     tags:
   *       - Organization
   *     summary: Grant organization admin
   *     description: |
   *       Owner-only: an admin able to appoint further admins would make the
   *       grant self-propagating. The target must already belong to a group in
   *       the organization. An org admin may administer every group in the
   *       organization — its members, quotas, settings and invites — without
   *       being a member of any of them. The role confers no approver rights
   *       and no membership, and two routes actively hold that line: nobody
   *       may raise their own group permissions, and a caller acting on
   *       organization authority may not name themselves a group's approver.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - userId
   *             properties:
   *               userId:
   *                 type: string
   *     responses:
   *       '201':
   *         description: The organization's administrators after the grant
   *       '403':
   *         description: Caller is not the organization owner
   *       '422':
   *         description: The target belongs to no group in this organization
   */
  app.post(
    "/admins",
    bodyValidationMiddleware(validatePostOrganizationAdmin),
    tryCatch(handlePostOrganizationAdmin)
  );

  /**
   * @openapi
   * /api/organization/admins/{userId}:
   *   delete:
   *     tags:
   *       - Organization
   *     summary: Revoke organization admin
   *     description: Owner-only. The owner's own rights are not stored and cannot be revoked.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The organization's administrators after the revoke
   *       '403':
   *         description: Caller is not the organization owner
   *       '404':
   *         description: The target is not an administrator of this organization
   */
  app.delete("/admins/:userId", tryCatch(handleDeleteOrganizationAdmin));

  return app;
};
