import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validatePatchOrganization,
  validatePostOrganizationAdmin,
  validatePutAttendanceSettings,
} from "../services/organization/types.js";
import { handleGetOrganization } from "../controllers/organization/handleGetOrganization.js";
import { handleGetOrganizations } from "../controllers/organization/handleGetOrganizations.js";
import { handlePatchOrganization } from "../controllers/organization/handlePatchOrganization.js";
import { handleGetOrganizationCandidates } from "../controllers/organization/handleGetOrganizationCandidates.js";
import { handlePostOrganizationAdmin } from "../controllers/organization/handlePostOrganizationAdmin.js";
import { handleDeleteOrganizationAdmin } from "../controllers/organization/handleDeleteOrganizationAdmin.js";
import { handleGetAttendanceSettings } from "../controllers/organization/handleGetAttendanceSettings.js";
import { handlePutAttendanceSettings } from "../controllers/organization/handlePutAttendanceSettings.js";
import { handlePostOrganizationExport } from "../controllers/organization/handlePostOrganizationExport.js";
import { handleGetOrganizationExport } from "../controllers/organization/handleGetOrganizationExport.js";
import { handleGetDirectorySettings } from "../controllers/directory/handleGetDirectorySettings.js";
import { handlePostEnableDirectory } from "../controllers/directory/handlePostEnableDirectory.js";
import { handlePostDisableDirectory } from "../controllers/directory/handlePostDisableDirectory.js";
import { handlePostAcceptDirectoryAgreement } from "../controllers/directory/handlePostAcceptDirectoryAgreement.js";
import { validateDirectoryAgreementBody } from "../services/directory/types.js";

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
   *     summary: Rename the organization, repoint billing, or toggle the Sick day benefit
   *     description: |
   *       The name and `sickDayBenefitEnabled` are editable by any organization
   *       admin. `billingEmail` is owner-only — it is where subscription grace
   *       warnings are sent. Switching the Sick day benefit on requires a paid
   *       plan; disabling — or re-sending the current value — is always
   *       allowed, and disabling preserves every allowance and record.
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
   *               sickDayBenefitEnabled:
   *                 type: boolean
   *     responses:
   *       '200':
   *         description: The updated organization
   *       '400':
   *         description: |
   *           `organizationId` omitted by a delegated admin who owns no
   *           organization and administers several.
   *       '402':
   *         description: |
   *           Enabling the Sick day benefit on the Free plan.
   *           `errors[].context` carries `{ reason: "PLAN_LIMIT" }`.
   *       '403':
   *         description: Not an admin, or not the owner for `billingEmail`
   *       '404':
   *         description: Organization not found
   *       '422':
   *         description: Body carried no editable field
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
   *       administrators and anyone who deleted their account. Owner-only.
   *       Deliberately not a lookup by email, which would let an owner probe
   *       whether an address has an account.
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
   *         description: |
   *           The target belongs to no group in this organization, or deleted
   *           their account
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

  /**
   * @openapi
   * /api/organization/export:
   *   post:
   *     tags:
   *       - Organization
   *     summary: Request the Organization export (owner only)
   *     description: |
   *       The owner's copy of everything the organization holds: one folder
   *       per person in the Person export layout under `people/`, plus
   *       `organization.json` with the organization, its settings, groups,
   *       memberships, administrators and group events. Works on every plan,
   *       at any time. The ZIP is built in the background on the Person
   *       export queue; the answer is the `PENDING` export. Each request
   *       writes one `export` row to the Read log for every person in it. A
   *       second request while one is still preparing returns that one and
   *       logs nothing. When it is ready the owner gets an `export_ready`
   *       notification and signs links with
   *       `POST /api/person-exports/{exportId}/download`. Deleting the
   *       organization deletes its exports. Rules in `docs/person-export.md`.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *         description: Defaults to the caller's own organization.
   *     responses:
   *       '202':
   *         description: The export, `PENDING` until its ZIP is ready
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PersonExport'
   *       '400':
   *         description: No `organizationId` while the caller administers several organizations
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           Not an admin of the organization, or a delegated admin, for whom
   *           `context.code` is `OWNER_ONLY`.
   *       '404':
   *         description: No such organization
   *       '422':
   *         description: An empty `organizationId`
   *       '503':
   *         description: "`context.code` is `EXPORT_UNAVAILABLE`: no organization-data store is configured"
   *   get:
   *     tags:
   *       - Organization
   *     summary: The owner's newest Organization export (owner only)
   *     description: |
   *       The newest Organization export the caller requested that has not
   *       expired, or null. The Organization page polls it while it is
   *       `PENDING`.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The newest export, or null
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [export]
   *               properties:
   *                 export:
   *                   nullable: true
   *                   allOf:
   *                     - $ref: '#/components/schemas/PersonExport'
   *       '400':
   *         description: No `organizationId` while the caller administers several organizations
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "Not the owner; `context.code` is `OWNER_ONLY` for a delegated admin"
   *       '404':
   *         description: No such organization
   *       '422':
   *         description: An empty `organizationId`
   */
  app.post("/export", tryCatch(handlePostOrganizationExport));
  app.get("/export", tryCatch(handleGetOrganizationExport));

  /**
   * @openapi
   * /api/organization/attendance-settings:
   *   get:
   *     tags:
   *       - Organization
   *     summary: The organization's attendance rules
   *     description: |
   *       Organization admins only, owner and delegate alike. An organization
   *       that never set attendance up has no row and gets the defaults with
   *       the feature off — the screen renders the same form either way.
   *
   *       `active` is the live answer: the stored toggle alone does not make
   *       attendance usable, it also needs a live non-Free entitlement. Once a
   *       lapsed subscription's grace has run out, `attendanceEnabled` stays
   *       true, `active` goes false and the settings stay readable.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The attendance settings
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AttendanceSettings'
   *       '400':
   *         description: |
   *           `organizationId` omitted by a delegated admin who owns no
   *           organization and administers several.
   *       '403':
   *         description: Caller does not administer this organization
   *       '404':
   *         description: No such organization, or the caller has none yet
   */
  /**
   * @openapi
   * components:
   *   schemas:
   *     AttendanceSettings:
   *       type: object
   *       properties:
   *         organizationId:
   *           type: string
   *         attendanceEnabled:
   *           type: boolean
   *         locationEnabled:
   *           type: boolean
   *         timezone:
   *           type: string
   *           nullable: true
   *         holidayCountry:
   *           type: string
   *           nullable: true
   *         workingDays:
   *           type: array
   *           items:
   *             type: integer
   *         breakMinutes:
   *           type: integer
   *         breakThresholdMinutes:
   *           type: integer
   *         requiredMinutesPerDay:
   *           type: integer
   *         balanceMode:
   *           type: string
   *           enum: [DAILY, MONTHLY]
   *         sessionCeilingMinutes:
   *           type: integer
   *         breakCeilingMinutes:
   *           type: integer
   *         selfServiceEnabled:
   *           type: boolean
   *           description: Whether employees may correct their own attendance at all.
   *         selfServiceDays:
   *           type: integer
   *           nullable: true
   *           minimum: 0
   *           maximum: 366
   *           description: |
   *             How many calendar days before today the self-service window
   *             reaches, in the organization's timezone; 0 is today only and
   *             null is no limit. Meaningless while `selfServiceEnabled` is
   *             false.
   *         active:
   *           type: boolean
   *           description: |
   *             Enabled and on a live non-Free entitlement — a paid subscription,
   *             one still inside its grace window, or an active `PRO`,
   *             `ENTERPRISE` or `CUSTOM` manual override. False once grace runs
   *             out, without the stored toggle moving.
   */
  app.get("/attendance-settings", tryCatch(handleGetAttendanceSettings));

  /**
   * @openapi
   * /api/organization/attendance-settings:
   *   put:
   *     tags:
   *       - Organization
   *     summary: Replace the organization's attendance rules
   *     description: |
   *       Organization admins only. A full replacement: every rule but
   *       `attendanceEnabled` is optional and falls back to its default, so a
   *       body naming only the switch writes the documented defaults rather
   *       than nulls. The self-service window is the exception: a body that
   *       leaves `selfServiceEnabled` or `selfServiceDays` out keeps what is
   *       stored, so a client that predates the window cannot switch it off.
   *
   *       Every successful save appends one row to the settings change log —
   *       who, when, and the settings before and after — in the same
   *       transaction. Nothing reads the log back.
   *
   *       Turning attendance on requires a timezone — it fixes the business
   *       date — and a live non-Free entitlement: a paid subscription, one
   *       still inside its grace window, or an active `PRO`, `ENTERPRISE` or
   *       `CUSTOM` manual override. Only an actual switch-on is gated, so an
   *       organization whose grace has run out can still correct its rules,
   *       and turning the feature off is never refused.
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
   *               - attendanceEnabled
   *             properties:
   *               attendanceEnabled:
   *                 type: boolean
   *               locationEnabled:
   *                 type: boolean
   *                 default: false
   *               timezone:
   *                 type: string
   *                 nullable: true
   *                 description: IANA zone, e.g. `Europe/Prague`. Required when enabling.
   *               holidayCountry:
   *                 type: string
   *                 nullable: true
   *                 description: ISO 3166-1 alpha-2, validated against the holiday dataset.
   *               workingDays:
   *                 type: array
   *                 default: [1, 2, 3, 4, 5]
   *                 items:
   *                   type: integer
   *                   minimum: 0
   *                   maximum: 6
   *                 description: '`Date.getUTCDay()` numbers, 0=Sunday.'
   *               breakMinutes:
   *                 type: integer
   *                 minimum: 0
   *                 maximum: 480
   *                 default: 30
   *               breakThresholdMinutes:
   *                 type: integer
   *                 minimum: 0
   *                 maximum: 1440
   *                 default: 360
   *               requiredMinutesPerDay:
   *                 type: integer
   *                 minimum: 0
   *                 maximum: 1440
   *                 default: 480
   *               balanceMode:
   *                 type: string
   *                 enum: [DAILY, MONTHLY]
   *                 default: DAILY
   *               sessionCeilingMinutes:
   *                 type: integer
   *                 minimum: 60
   *                 maximum: 1440
   *                 default: 960
   *               breakCeilingMinutes:
   *                 type: integer
   *                 minimum: 15
   *                 maximum: 1440
   *                 default: 120
   *               selfServiceEnabled:
   *                 type: boolean
   *                 description: Omitted keeps the stored value, false for a first save.
   *               selfServiceDays:
   *                 type: integer
   *                 nullable: true
   *                 minimum: 0
   *                 maximum: 366
   *                 description: |
   *                   Days back from today; null is no limit. Omitted keeps the
   *                   stored value, 0 for a first save.
   *     responses:
   *       '200':
   *         description: The saved attendance settings
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AttendanceSettings'
   *       '400':
   *         description: |
   *           `organizationId` omitted by a delegated admin who owns no
   *           organization and administers several.
   *       '402':
   *         description: |
   *           Turning attendance on without a live non-Free entitlement.
   *           `errors[].context` carries `{ reason: "PLAN_LIMIT" }`.
   *       '403':
   *         description: Caller does not administer this organization
   *       '404':
   *         description: Organization not found
   *       '422':
   *         description: |
   *           A rule outside its range (`selfServiceDays` must be a whole number
   *           from 0 to 366, or null), an unknown timezone or holiday country,
   *           or `attendanceEnabled` true with no timezone.
   */
  app.put(
    "/attendance-settings",
    bodyValidationMiddleware(validatePutAttendanceSettings),
    tryCatch(handlePutAttendanceSettings)
  );

  /**
   * @openapi
   * components:
   *   schemas:
   *     DirectoryState:
   *       type: object
   *       properties:
   *         organizationId:
   *           type: string
   *         isOwner:
   *           type: boolean
   *         enabled:
   *           type: boolean
   *           description: |
   *             The stored toggle. It stays on through a lapse or a downgrade
   *             until the owner turns it off (a Directory organization).
   *         enabledAt:
   *           type: string
   *           format: date-time
   *           nullable: true
   *         disabledAt:
   *           type: string
   *           format: date-time
   *           nullable: true
   *         writable:
   *           type: boolean
   *           description: |
   *             The plan passes the directory gate right now: Enterprise (paid,
   *             trialing or in grace), or an active `ENTERPRISE` or `CUSTOM`
   *             manual override. Turning on and adding data need it.
   *         agreement:
   *           type: object
   *           properties:
   *             currentVersion:
   *               type: integer
   *             acceptedVersion:
   *               type: integer
   *               nullable: true
   *             acceptedAt:
   *               type: string
   *               format: date-time
   *               nullable: true
   *             acceptedByName:
   *               type: string
   *               nullable: true
   *             newVersionReady:
   *               type: boolean
   *               description: On, and the latest acceptance is older than the current version.
   *         people:
   *           type: object
   *           description: Live Employment counts for the enable dialog's summary.
   *           properties:
   *             open:
   *               type: integer
   *             former:
   *               type: integer
   */

  /**
   * @openapi
   * /api/organization/directory:
   *   get:
   *     tags:
   *       - Organization
   *     summary: Whether the people directory is on, and its agreement
   *     description: |
   *       Organization admins only, owner and delegate alike. An organization
   *       that never turned the directory on has no settings row and answers
   *       `enabled: false`. Carries no Profile field.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The directory state
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryState'
   *       '400':
   *         description: |
   *           `organizationId` omitted by a delegated admin who owns no
   *           organization and administers several.
   *       '403':
   *         description: Caller does not administer this organization
   *       '404':
   *         description: No such organization, or the caller has none yet
   */
  app.get("/directory", tryCatch(handleGetDirectorySettings));

  /**
   * @openapi
   * /api/organization/directory/enable:
   *   post:
   *     tags:
   *       - Organization
   *     summary: Turn the people directory on and accept its agreement
   *     description: |
   *       Owner only. In one transaction it writes the directory settings row
   *       (on, by whom, when), an agreement acceptance row for the current
   *       version, and the organization's own copy of the product's default
   *       Permission table, fixed cells included. A re-enable keeps the cells
   *       the organization already stored and adds only the cells the product
   *       gained since. Nothing is written per Employment.
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
   *               - agreementVersion
   *             properties:
   *               agreementVersion:
   *                 type: integer
   *                 minimum: 1
   *                 description: The agreement version the owner was shown.
   *     responses:
   *       '200':
   *         description: The directory state after the change
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryState'
   *       '400':
   *         description: Invalid body, or no unambiguous default organization
   *       '402':
   *         description: |
   *           The plan is Free or Pro (`reason: PLAN_LIMIT`,
   *           `code: DIRECTORY_PLAN_REQUIRED`).
   *       '403':
   *         description: Caller is not the organization owner (`code: OWNER_ONLY`)
   *       '404':
   *         description: No such organization
   *       '409':
   *         description: |
   *           `DIRECTORY_ALREADY_ON`, or `AGREEMENT_VERSION_STALE` when the
   *           version sent is not the current one.
   */
  app.post(
    "/directory/enable",
    bodyValidationMiddleware(validateDirectoryAgreementBody),
    tryCatch(handlePostEnableDirectory)
  );

  /**
   * @openapi
   * /api/organization/directory/disable:
   *   post:
   *     tags:
   *       - Organization
   *     summary: Turn the people directory off
   *     description: |
   *       Owner only, on every plan. Updates the settings row and keeps every
   *       other directory row, Permission table included. Ends nobody. Calling
   *       it while the directory is off changes nothing.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The directory state after the change
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryState'
   *       '403':
   *         description: Caller is not the organization owner (`code: OWNER_ONLY`)
   *       '404':
   *         description: No such organization
   */
  app.post("/directory/disable", tryCatch(handlePostDisableDirectory));

  /**
   * @openapi
   * /api/organization/directory/agreement:
   *   post:
   *     tags:
   *       - Organization
   *     summary: Accept a new version of the directory agreement
   *     description: |
   *       Owner only, on every plan. Stores one acceptance row for the current
   *       version. Until the owner accepts, nothing pauses; the web shows the
   *       owner a banner.
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
   *               - agreementVersion
   *             properties:
   *               agreementVersion:
   *                 type: integer
   *                 minimum: 1
   *     responses:
   *       '200':
   *         description: The directory state after the acceptance
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryState'
   *       '400':
   *         description: Invalid body
   *       '403':
   *         description: Caller is not the organization owner (`code: OWNER_ONLY`)
   *       '404':
   *         description: No such organization
   *       '409':
   *         description: |
   *           `DIRECTORY_OFF` while the directory is off, or
   *           `AGREEMENT_VERSION_STALE`.
   */
  app.post(
    "/directory/agreement",
    bodyValidationMiddleware(validateDirectoryAgreementBody),
    tryCatch(handlePostAcceptDirectoryAgreement)
  );

  return app;
};
