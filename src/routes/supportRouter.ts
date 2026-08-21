import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { requireSupportAdmin } from "../middleware/supportGuard.js";
import { handleSearchOrganizations } from "../controllers/support/handleSearchOrganizations.js";
import { handleGetOrganizationDetail } from "../controllers/support/handleGetOrganizationDetail.js";
import { handleGetGroupDetail } from "../controllers/support/handleGetGroupDetail.js";

/**
 * Platform-support read surface. Only mounted when `SUPPORT_ADMIN_USER_IDS`
 * is set; every request passes `requireSupportAdmin` (allowlist + 2FA) and is
 * written to the `support_access` audit table. Read-only by design — support
 * debugging never writes customer data, and adding a mutating route here
 * would need its own justification, not just this router's guard.
 */
export const supportRouter = (): Router => {
  const app = Router();

  app.use(requireSupportAdmin);

  /**
   * @openapi
   * /api/support/organizations:
   *   get:
   *     tags:
   *       - Support
   *     summary: Search organizations across the whole platform
   *     description: |
   *       Support-allowlist only (404 for anyone else, 403 without 2FA on the
   *       account). Matches organization name, owner name or email, or an
   *       exact organization id; without `query`, the newest organizations.
   *       Every call is written to the `support_access` audit table.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: query
   *         schema:
   *           type: string
   *           maxLength: 200
   *     responses:
   *       '200':
   *         description: '`{ organizations }` with owner, live group count and plan'
   *       '403':
   *         description: Allowlisted caller without two-factor enabled
   *       '404':
   *         description: Caller is not on the support allowlist
   */
  app.get("/organizations", tryCatch(handleSearchOrganizations));

  /**
   * @openapi
   * /api/support/organizations/{organizationId}:
   *   get:
   *     tags:
   *       - Support
   *     summary: Organization detail for support debugging
   *     description: |
   *       Support-allowlist only. Owner, resolved plan entitlements, all
   *       groups **including deleted ones**, and the administrator list.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Organization, owner, plan, groups, admins
   *       '403':
   *         description: Allowlisted caller without two-factor enabled
   *       '404':
   *         description: Not allowlisted, or no such organization
   */
  app.get("/organizations/:organizationId", tryCatch(handleGetOrganizationDetail));

  /**
   * @openapi
   * /api/support/groups/{groupId}:
   *   get:
   *     tags:
   *       - Support
   *     summary: Group detail for support debugging
   *     description: |
   *       Support-allowlist only. Group settings, members including removed
   *       ones, quota rows for every year, and the latest 200 vacation rows
   *       with their state timestamps. `note` and `rejectionReason` are
   *       deliberately excluded — they can carry personal detail debugging
   *       never needs.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: groupId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Group, members, quotas, vacations
   *       '403':
   *         description: Allowlisted caller without two-factor enabled
   *       '404':
   *         description: Not allowlisted, or no such group
   */
  app.get("/groups/:groupId", tryCatch(handleGetGroupDetail));

  return app;
};
