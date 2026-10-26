import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validateEndEmployment,
  validateEraseEmployment,
  validatePatchEmployment,
} from "../services/employment/types.js";
import { handleGetEmployment } from "../controllers/employment/handleGetEmployment.js";
import { handleGetEmployments } from "../controllers/employment/handleGetEmployments.js";
import { handlePatchEmployment } from "../controllers/employment/handlePatchEmployment.js";
import { handlePostEndEmployment } from "../controllers/employment/handlePostEndEmployment.js";
import { handlePostEraseEmployment } from "../controllers/employment/handlePostEraseEmployment.js";
import { handlePostEmploymentExport } from "../controllers/personExport/handlePostEmploymentExport.js";
import { handleGetRequestedExports } from "../controllers/personExport/handleGetRequestedExports.js";

export const employmentRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/employment:
   *   get:
   *     tags:
   *       - Employment
   *     summary: One Employment in an organization
   *     description: |
   *       One person's membership in one organization — the subject of
   *       attendance, with the spell it currently runs for and the per-person
   *       override of the organization's required minutes per day (null unless
   *       one was set). Defaults to the caller; `userId` asks about someone
   *       else and needs standing over them — their own group's admin, or an
   *       admin of the organization. `organizationId` is required: an employee
   *       may belong to several organizations and administers none, so there is
   *       no default to fall back on.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: userId
   *         description: Defaults to the caller.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           `{ id, organizationId, userId, startedAt, endedAt, ended,
   *           requiredMinutesPerDay }`
   *       '403':
   *         description: |
   *           The caller has no standing over that person. Decided before the
   *           lookup, so it does not leak whether the Employment exists.
   *       '404':
   *         description: No Employment for that person in that organization
   *       '422':
   *         description: Missing or malformed organizationId
   */
  app.get("/", tryCatch(handleGetEmployment));

  /**
   * @openapi
   * /api/employment/list:
   *   get:
   *     tags:
   *       - Employment
   *     summary: An organization's Employments
   *     description: |
   *       The roster, scoped to what the caller may read: every Employment for
   *       an organization admin, the members of the groups they administer for
   *       a group admin. A group's manager never counts as a member of the
   *       group they manage, whatever membership row they hold, so the admins
   *       of that group do not see them. Anyone who belongs to no group
   *       appears only for organization admins, as do ended ones, which carry
   *       `ended: true`. A group admin's slice is their groups' current
   *       members — their own row is not in it, and is on `GET
   *       /api/employment`. Callers who administer nothing get 403.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           Array of `{ id, userId, email, startedAt, endedAt, ended,
   *           requiredMinutesPerDay, accountDeletedAt, accountDeleted, user }`,
   *           by name. `requiredMinutesPerDay` is this person's own required
   *           time, null while the organization's rule stands.
   *           `accountDeletedAt` is when the person deleted their account, and
   *           `accountDeleted` says whether they did: the row then names them
   *           by the copy the organization kept and carries the "Account
   *           deleted" label.
   *       '422':
   *         description: Missing or malformed organizationId
   *       '403':
   *         description: The caller administers nothing in this organization
   */
  app.get("/list", tryCatch(handleGetEmployments));

  /**
   * @openapi
   * /api/employment/{employmentId}:
   *   patch:
   *     tags:
   *       - Employment
   *     summary: Override one person's required minutes per day
   *     description: |
   *       Replaces the organization's required daily time for this one
   *       Employment — the part-timer who would otherwise read as short every
   *       day. `null` clears the override and puts them back on the
   *       organization's figure, which is why the field is nullable rather than
   *       optional: a body with nothing in it would otherwise be
   *       indistinguishable from one asking to clear it.
   *
   *       Organization admins only. A group admin reads their members'
   *       attendance but does not decide what a contract owes, so the read
   *       matrix does not apply here.
   *
   *       Nothing recomputes: the month view measures against whatever the row
   *       says when it is read, so a change moves past balances too.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - requiredMinutesPerDay
   *             properties:
   *               requiredMinutesPerDay:
   *                 type: integer
   *                 nullable: true
   *                 minimum: 0
   *                 maximum: 1440
   *     responses:
   *       '200':
   *         description: |
   *           `{ id, organizationId, userId, startedAt, endedAt, ended,
   *           requiredMinutesPerDay }`
   *       '403':
   *         description: The caller does not administer that organization
   *       '404':
   *         description: No such Employment
   *       '422':
   *         description: Missing or out-of-range requiredMinutesPerDay
   */
  app.patch(
    "/:employmentId",
    bodyValidationMiddleware(validatePatchEmployment),
    tryCatch(handlePatchEmployment)
  );

  /**
   * @openapi
   * /api/employment/{employmentId}/end:
   *   post:
   *     tags:
   *       - Employment
   *     summary: End employment
   *     description: |
   *       Ends the person's Employment in its organization on `endedOn`, today
   *       or earlier in the organization's time zone (UTC while attendance was
   *       never set up). In one transaction it removes the person from every
   *       group of the organization, clears them from the groups' approver
   *       slots, drops their delegated org-admin row, and cancels their
   *       pending requests and their approved bookings after today. Past
   *       bookings and today's stay. Each cancelled day gets a CANCELLED event
   *       with the caller as actor and the reason "employment ended". Nobody
   *       is notified.
   *
   *       The owner and org admins only, never plan-gated, attendance on or
   *       off. For now only a Deleted account's Employment can be ended: the
   *       Employment is one row per organization, so ending a live person and
   *       adding them back would overwrite the spell. The account itself, and
   *       the person's records in other organizations, are untouched.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - endedOn
   *             properties:
   *               endedOn:
   *                 type: string
   *                 format: date
   *                 description: The last day of the spell.
   *     responses:
   *       '200':
   *         description: |
   *           `{ id, organizationId, userId, startedAt, endedAt, ended,
   *           requiredMinutesPerDay, cancelledBookings }`. `endedAt` is now
   *           when `endedOn` is today, otherwise the last instant of that day
   *           in the organization's zone. `cancelledBookings` counts the
   *           cancelled days.
   *       '403':
   *         description: The caller is not the owner or an org admin of the organization
   *       '404':
   *         description: No such Employment
   *       '409':
   *         description: |
   *           `context.code` is `EMPLOYMENT_ENDED` when it already ended, or
   *           `MANAGES_GROUP` while the person manages one of the
   *           organization's groups.
   *       '422':
   *         description: |
   *           A malformed id or date, or `context.code` is
   *           `END_DATE_IN_FUTURE`, `END_DATE_BEFORE_START` (before the spell
   *           started) or `ACCOUNT_NOT_DELETED`.
   */
  app.post(
    "/:employmentId/end",
    bodyValidationMiddleware(validateEndEmployment),
    tryCatch(handlePostEndEmployment)
  );

  /**
   * @openapi
   * /api/employment/{employmentId}/erase:
   *   post:
   *     tags:
   *       - Employment
   *     summary: Erase a person's organization data
   *     description: |
   *       Removes everything the organization holds about the Employment's
   *       person, across every spell, in one transaction: their Employments
   *       with attendance sessions, breaks and events, bookings in any state
   *       with their timelines and attachments, quotas, group memberships,
   *       delegated org-admin rows, mirrors, the change log entries about them,
   *       their Person exports, and the organization's Organization exports,
   *       which hold them too. An open Employment is ended today first,
   *       as End employment does. Attachment files and export ZIPs are deleted
   *       after the commit; a store failure is logged and the erase stands.
   *
   *       What stays: the person's records in other organizations, the
   *       stripped user row, the Read log rows about the person, and other
   *       people's records the person approved, created or changed, which then
   *       name them "Deleted account".
   *
   *       The owner and org admins only, never plan-gated, and only for a
   *       Deleted account. `confirmName` must match the name the People card
   *       shows, ignoring case and extra spaces.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - confirmName
   *             properties:
   *               confirmName:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 200
   *                 description: The person's name, typed by the admin.
   *     responses:
   *       '204':
   *         description: Erased
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: The caller is not the owner or an org admin of the organization
   *       '404':
   *         description: No such Employment
   *       '409':
   *         description: |
   *           `context.code` is `MANAGES_GROUP` while the person manages one
   *           of the organization's groups, so the open Employment can't end.
   *       '422':
   *         description: |
   *           A malformed id or body, or `context.code` is `NAME_MISMATCH`
   *           (the typed name is not the person's) or `ACCOUNT_NOT_DELETED`.
   */
  app.post(
    "/:employmentId/erase",
    bodyValidationMiddleware(validateEraseEmployment),
    tryCatch(handlePostEraseEmployment)
  );

  /**
   * @openapi
   * /api/employment/{employmentId}/export:
   *   post:
   *     tags:
   *       - Person export
   *     summary: Request a Person export
   *     description: |
   *       Starts a Person export: everything the organization holds about the
   *       Employment's person across every spell, as a ZIP of `person.json`,
   *       four CSVs (bookings, attendance sessions, quotas, changes) and the
   *       attachments. Account data stays out. The ZIP is built in the
   *       background; the answer is the export row in `PENDING`, and the
   *       caller gets an `export_ready` notification once it is `READY`.
   *
   *       The owner and org admins only, on every plan, for any Employment:
   *       open or ended, account bound or deleted. Group managers and members
   *       get 403. Each new request writes one `export` row to the Read log.
   *       While an earlier request by the same caller for the same person is
   *       still `PENDING`, that one is returned and nothing new is written.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '202':
   *         description: The export, `PENDING`
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PersonExport'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: The caller is not the owner or an org admin of the organization
   *       '404':
   *         description: No such Employment
   *       '422':
   *         description: Malformed employment id
   *       '503':
   *         description: "`context.code` is `EXPORT_UNAVAILABLE`: no organization-data store is configured"
   */
  app.post("/:employmentId/export", tryCatch(handlePostEmploymentExport));

  /**
   * @openapi
   * /api/employment/exports:
   *   get:
   *     tags:
   *       - Person export
   *     summary: The Person exports the caller requested in an organization
   *     description: |
   *       The newest export per person that the caller requested in the
   *       organization, so the People card can show Preparing or Download on
   *       each row. Exports past their 7 days are left out. The owner and org
   *       admins only.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Newest first
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/PersonExport'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: The caller is not the owner or an org admin of the organization
   *       '422':
   *         description: Missing organizationId
   */
  app.get("/exports", tryCatch(handleGetRequestedExports));

  return app;
};
