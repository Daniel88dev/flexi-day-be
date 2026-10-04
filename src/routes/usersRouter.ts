import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetMyApprovals } from "../controllers/users/handleGetMyApprovals.js";
import { handleGetMyDashboardSummary } from "../controllers/users/handleGetMyDashboardSummary.js";
import { handleGetMyBalances } from "../controllers/users/handleGetMyBalances.js";
import { handleGetMySettings } from "../controllers/users/handleGetMySettings.js";
import { handlePutMySettings } from "../controllers/users/handlePutMySettings.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutUserSettings } from "../services/userSettings/types.js";
import { handleGetMyDeletion } from "../controllers/users/handleGetMyDeletion.js";
import { handlePostDeleteMe } from "../controllers/users/handlePostDeleteMe.js";
import { validatePostDeleteMe } from "../services/accountDeletion/types.js";
import { handlePostAppleAuthorization } from "../controllers/users/handlePostAppleAuthorization.js";
import { validatePostAppleAuthorization } from "../services/appleAuthorization/types.js";

export const usersRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/users/me/approvals:
   *   get:
   *     tags:
   *       - Users
   *     summary: List pending vacations the caller can approve
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Array of pending approvals with contiguous days collapsed
   */
  app.get("/me/approvals", tryCatch(handleGetMyApprovals));

  /**
   * @openapi
   * /api/users/me/dashboard-summary:
   *   get:
   *     tags:
   *       - Users
   *     summary: Rolled-up dashboard counts for the caller
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Stat-card counts
   */
  app.get("/me/dashboard-summary", tryCatch(handleGetMyDashboardSummary));

  /**
   * @openapi
   * /api/users/me/balances:
   *   get:
   *     tags:
   *       - Users
   *     summary: Aggregated leave balances for the caller for a given year
   *     description: |
   *       One bucket per record type, summed across the caller's groups.
   *       `allocated` is the year's quota, plus carry-over for Vacation; a
   *       group with no quota row for the year contributes its defaults, the
   *       same allowance the booking guard enforces. A Sick day bucket is
   *       allocated only through groups whose organization has the Sick day
   *       benefit enabled. `used` counts approved days and `pending` days
   *       awaiting a decision, half days as 0.5.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: year
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *     responses:
   *       '200':
   *         description: Balance buckets per calendar record type
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 year:
   *                   type: string
   *                 buckets:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       type:
   *                         type: string
   *                       allocated:
   *                         type: number
   *                       used:
   *                         type: number
   *                       pending:
   *                         type: number
   *       '401':
   *         description: Not authenticated
   *       '422':
   *         description: Invalid year
   */
  app.get("/me/balances", tryCatch(handleGetMyBalances));

  /**
   * @openapi
   * /api/users/me/settings:
   *   get:
   *     tags:
   *       - Users
   *     summary: The caller's preferences
   *     description: |
   *       Users without a stored row are on the defaults
   *       (`emailNotifications: true`, `dashboardScope: MINE`,
   *       `dashboardGroupId: null`, `dashboardCalendarView: LANES`,
   *       `attendanceLocationNoticeDismissed: false`).
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Preference flags
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserSettings'
   *       '401':
   *         description: Not signed in
   *   put:
   *     tags:
   *       - Users
   *     summary: Update the caller's preferences
   *     description: |
   *       A partial update — the screen saves one card at a time, so any subset
   *       of the fields may be sent and the rest keep their stored value.
   *
   *       Turning `emailNotifications` off suppresses workflow mail (approval
   *       requests, decisions, cancellations). Account mail such as email
   *       confirmation is unaffected.
   *
   *       `dashboardScope: GROUP` makes the dashboard calendar show
   *       `dashboardGroupId`'s records instead of only the caller's own. That
   *       group must already be selected or supplied in the same request, and
   *       the caller must have view access on it. That check runs only when
   *       the request sends `dashboardScope` or `dashboardGroupId`, so saving
   *       any other field succeeds even if the stored group is no longer
   *       viewable.
   *
   *       `dashboardCalendarView` picks how the dashboard month calendar draws
   *       leave: `LANES` (one bar per person, the default) or `STRIPES`
   *       (compact stripes with a day list). Every client reads the same value.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             allOf:
   *               - $ref: '#/components/schemas/UserSettings'
   *             minProperties: 1
   *     responses:
   *       '200':
   *         description: The stored preferences
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserSettings'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: No access to view the selected group's records
   *       '422':
   *         description: |
   *           The body failed validation (no field supplied, or a value outside
   *           its enum, such as a `dashboardCalendarView` other than `LANES` or
   *           `STRIPES`), or group scope was requested without a group
   * components:
   *   schemas:
   *     UserSettings:
   *       type: object
   *       properties:
   *         emailNotifications:
   *           type: boolean
   *         dashboardScope:
   *           type: string
   *           enum: [MINE, GROUP]
   *         dashboardGroupId:
   *           type: string
   *           nullable: true
   *         dashboardCalendarView:
   *           type: string
   *           enum: [LANES, STRIPES]
   *           default: LANES
   *           description: How the dashboard month calendar draws leave.
   *         attendanceLocationNoticeDismissed:
   *           type: boolean
   *           description: |
   *             Whether the person has dismissed the clock's notice that the
   *             organization records location. The widget sets it and then
   *             never shows the notice again; an ordinary preference otherwise,
   *             so sending `false` brings the notice back for that person and
   *             nobody else.
   */
  app.get("/me/settings", tryCatch(handleGetMySettings));
  app.put(
    "/me/settings",
    bodyValidationMiddleware(validatePutUserSettings),
    tryCatch(handlePutMySettings)
  );

  /**
   * @openapi
   * /api/users/me/deletion:
   *   get:
   *     tags:
   *       - Users
   *     summary: Whether the caller can delete their account now
   *     description: |
   *       Lists every blocker, not just the first, and says how the delete
   *       must be confirmed, so a client can show both before asking for
   *       anything. `confirmation` is `password` for a user with an
   *       email-and-password account and `recent-sign-in` for a social-only
   *       user, whose session must be under 24 hours old. Works with a web
   *       cookie or a Native session. The policy is in
   *       `docs/account-deletion.md`.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Deletion status
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AccountDeletionStatus'
   *       '401':
   *         description: Not signed in
   * components:
   *   schemas:
   *     AccountDeletionStatus:
   *       type: object
   *       required: [canDelete, blockers, confirmation]
   *       properties:
   *         canDelete:
   *           type: boolean
   *           description: True when `blockers` is empty.
   *         blockers:
   *           type: array
   *           items:
   *             $ref: '#/components/schemas/DeletionBlocker'
   *         confirmation:
   *           type: string
   *           enum: [password, recent-sign-in]
   *     DeletionBlocker:
   *       description: |
   *         One reason the account cannot be deleted yet, told apart by `kind`.
   *         `GROUP_HAS_MEMBERS`: the caller manages a live group in which
   *         another user has a live membership. `ORGANIZATION_HAS_MEMBERS`:
   *         the caller owns an organization in which another user has an open
   *         Employment. `SUBSCRIPTION_RENEWING`: an organization the caller
   *         owns has a Paddle subscription that is not `canceled` and has no
   *         scheduled cancellation; cancel it in the customer portal first.
   *         `SUPPORT_ADMIN`: the caller is a platform support admin, or was
   *         one and has a support access trail.
   *       oneOf:
   *         - type: object
   *           required: [kind, groupId, groupName, otherMembers]
   *           properties:
   *             kind:
   *               type: string
   *               enum: [GROUP_HAS_MEMBERS]
   *             groupId:
   *               type: string
   *               format: uuid
   *             groupName:
   *               type: string
   *             otherMembers:
   *               type: integer
   *               description: Live members other than the caller.
   *         - type: object
   *           required: [kind, organizationId, organizationName, otherMembers]
   *           properties:
   *             kind:
   *               type: string
   *               enum: [ORGANIZATION_HAS_MEMBERS]
   *             organizationId:
   *               type: string
   *               format: uuid
   *             organizationName:
   *               type: string
   *             otherMembers:
   *               type: integer
   *               description: Open Employments other than the caller's.
   *         - type: object
   *           required: [kind, organizationId, organizationName]
   *           properties:
   *             kind:
   *               type: string
   *               enum: [SUBSCRIPTION_RENEWING]
   *             organizationId:
   *               type: string
   *               format: uuid
   *             organizationName:
   *               type: string
   *         - type: object
   *           required: [kind]
   *           properties:
   *             kind:
   *               type: string
   *               enum: [SUPPORT_ADMIN]
   *       discriminator:
   *         propertyName: kind
   */
  app.get("/me/deletion", tryCatch(handleGetMyDeletion));

  /**
   * @openapi
   * /api/users/me/delete:
   *   post:
   *     tags:
   *       - Users
   *     summary: Delete the caller's account
   *     description: |
   *       Hard-deletes the account in one transaction: the user and everything
   *       that hangs off them, the groups they manage and the organizations
   *       they own (both only possible once nobody else is in them), with
   *       their subscription rows. The caller is cleared from main and temp
   *       approver slots of other people's groups, and quota changes they
   *       made stay with a deleted-actor marker. Stored attachment objects
   *       are removed after the commit; a failure there is logged and does not
   *       fail the request. Every session ends, web and Native, so the old
   *       cookie answers 401 afterwards. A wrong password counts toward the
   *       API's failure rate limit. The full policy is in
   *       `docs/account-deletion.md`.
   *
   *       Blockers are checked again inside the deleting transaction, under
   *       the same organization locks a join takes, so someone joining in
   *       between still blocks the delete.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               password:
   *                 type: string
   *                 description: |
   *                   The current password. Required when the deletion status
   *                   says `confirmation: password`; ignored otherwise.
   *     responses:
   *       '204':
   *         description: |
   *           Deleted. The response expires the session cookies.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           Not confirmed, and nothing changed. `errors[0].context.reason`
   *           is `PASSWORD_INVALID` for a wrong or missing password, or
   *           `REAUTH_REQUIRED` for a social-only user whose session is over
   *           24 hours old; send them through sign-in again.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 errors:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       message:
   *                         type: string
   *                       context:
   *                         type: object
   *                         properties:
   *                           reason:
   *                             type: string
   *                             enum: [PASSWORD_INVALID, REAUTH_REQUIRED]
   *       '409':
   *         description: |
   *           At least one blocker applies, and nothing changed.
   *           `errors[0].context` carries `reason: DELETION_BLOCKED` and the
   *           full `blockers` list, the same one the deletion status returns.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 errors:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       message:
   *                         type: string
   *                       context:
   *                         type: object
   *                         properties:
   *                           reason:
   *                             type: string
   *                             enum: [DELETION_BLOCKED]
   *                           blockers:
   *                             type: array
   *                             items:
   *                               $ref: '#/components/schemas/DeletionBlocker'
   *       '422':
   *         description: The body failed validation (a `password` that is not a string)
   */
  app.post(
    "/me/delete",
    bodyValidationMiddleware(validatePostDeleteMe),
    tryCatch(handlePostDeleteMe)
  );

  /**
   * @openapi
   * /api/users/me/apple-authorization:
   *   post:
   *     tags:
   *       - Users
   *     summary: Store the Apple tokens behind the phone's Sign in with Apple
   *     description: |
   *       The phone app calls this right after an Apple sign-in, with the
   *       one-time `authorizationCode` Apple's sheet returned. A sign-in by id
   *       token stores no refresh token, and deleting the account has to revoke
   *       one at Apple, so the backend exchanges the code at Apple's token
   *       endpoint as the app (client id the bundle id, client secret minted
   *       for it), verifies the returned id token (issuer Apple, audience the
   *       bundle id), and stores the refresh token, access token, its expiry
   *       and the id token on the caller's Apple account link whose subject
   *       matches. The access and refresh token are encrypted like every token
   *       better-auth writes.
   *
   *       A code is single-use and expires after five minutes, so the call is
   *       never retried, here or by the phone; a later Apple sign-in brings a
   *       new code and fills a link that missed one. A sign-in alone never
   *       clears a stored token. Native session only: a web session has no
   *       code to give.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [authorizationCode]
   *             properties:
   *               authorizationCode:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 2048
   *                 description: |
   *                   The `authorizationCode` from `expo-apple-authentication`'s
   *                   `signInAsync`, sent as received.
   *     responses:
   *       '204':
   *         description: Stored.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           A web session, and nothing changed. `errors[0].context.reason`
   *           is `NATIVE_SESSION_REQUIRED`.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppleAuthorizationError'
   *       '409':
   *         description: |
   *           Nothing changed. `errors[0].context.reason` is
   *           `APPLE_ACCOUNT_MISSING` when the caller has no Apple account
   *           link, or `APPLE_SUBJECT_MISMATCH` when the code belongs to an
   *           Apple ID other than the one linked.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppleAuthorizationError'
   *       '422':
   *         description: The body failed validation (`authorizationCode` missing, empty or over 2048 characters)
   *       '502':
   *         description: |
   *           Apple refused or could not be reached, its answer carried no
   *           refresh token, or the id token it returned did not verify.
   *           Nothing changed, and the code is spent. `errors[0].context.reason`
   *           is `APPLE_EXCHANGE_FAILED`.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppleAuthorizationError'
   * components:
   *   schemas:
   *     AppleAuthorizationError:
   *       type: object
   *       properties:
   *         errors:
   *           type: array
   *           items:
   *             type: object
   *             properties:
   *               message:
   *                 type: string
   *               context:
   *                 type: object
   *                 properties:
   *                   reason:
   *                     type: string
   *                     enum:
   *                       - NATIVE_SESSION_REQUIRED
   *                       - APPLE_ACCOUNT_MISSING
   *                       - APPLE_SUBJECT_MISMATCH
   *                       - APPLE_EXCHANGE_FAILED
   */
  app.post(
    "/me/apple-authorization",
    bodyValidationMiddleware(validatePostAppleAuthorization),
    tryCatch(handlePostAppleAuthorization)
  );

  return app;
};
