import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetMyApprovals } from "../controllers/users/handleGetMyApprovals.js";
import { handleGetMyPendingRequests } from "../controllers/users/handleGetMyPendingRequests.js";
import { handleGetMyDashboardSummary } from "../controllers/users/handleGetMyDashboardSummary.js";
import { handleGetMyBalances } from "../controllers/users/handleGetMyBalances.js";
import { handleGetMySettings } from "../controllers/users/handleGetMySettings.js";
import { handlePutMySettings } from "../controllers/users/handlePutMySettings.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutUserSettings } from "../services/userSettings/types.js";
import { handleGetMyDeletion } from "../controllers/users/handleGetMyDeletion.js";
import { handleGetMyAccountExport } from "../controllers/users/handleGetMyAccountExport.js";
import { handlePostDeleteMe } from "../controllers/users/handlePostDeleteMe.js";
import { validatePostDeleteMe } from "../services/accountDeletion/types.js";
import { handlePostAppleAuthorization } from "../controllers/users/handlePostAppleAuthorization.js";
import { validatePostAppleAuthorization } from "../services/appleAuthorization/types.js";
import { handlePutPushRegistration } from "../controllers/users/handlePutPushRegistration.js";
import { handleDeletePushRegistration } from "../controllers/users/handleDeletePushRegistration.js";
import { validatePutPushRegistration } from "../services/pushRegistration/types.js";
import { requireNativeSession } from "../middleware/nativeSessionGuard.js";
import { handleGetMyBirthday } from "../controllers/users/handleGetMyBirthday.js";
import { handlePutMyBirthday } from "../controllers/users/handlePutMyBirthday.js";
import { handleDeleteMyBirthday } from "../controllers/users/handleDeleteMyBirthday.js";
import { validatePutBirthday } from "../services/birthday/types.js";

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
   *         description: Array of pending approvals, one item per request
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/PendingRange'
   */
  app.get("/me/approvals", tryCatch(handleGetMyApprovals));

  /**
   * @openapi
   * /api/users/me/pending-requests:
   *   get:
   *     tags:
   *       - Users
   *     summary: List the caller's own requests still waiting on an approver
   *     description: |
   *       The caller's own pending rows (not approved, rejected or cancelled)
   *       in every live group, with the pending days of each request collapsed
   *       into one range exactly as `/api/users/me/approvals` collapses them. Read-only: the caller
   *       cannot decide these.
   *
   *       A row the caller may decide themselves (they have approver access
   *       in its group and their records are not mirrored into that group) is
   *       left out, because `/api/users/me/approvals` lists it. No row appears
   *       in both responses for the same caller.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The caller's pending ranges; empty when nothing is waiting
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/PendingRange'
   *       '401':
   *         description: Not signed in
   * components:
   *   schemas:
   *     PendingRange:
   *       type: object
   *       required:
   *         - vacationIds
   *         - user
   *         - groupId
   *         - groupName
   *         - vacationType
   *         - from
   *         - to
   *         - businessDays
   *         - note
   *         - submittedAt
   *       properties:
   *         vacationIds:
   *           type: array
   *           description: Every still-pending vacation row of the request, oldest day first.
   *           items:
   *             type: string
   *             format: uuid
   *         user:
   *           $ref: '#/components/schemas/UserSummary'
   *         groupId:
   *           type: string
   *           format: uuid
   *         groupName:
   *           type: string
   *         vacationType:
   *           type: string
   *           enum: [VACATION, HOME_OFFICE, SICK, BANK_HOLIDAY, NON_PAID_LEAVE, PAID_TIME_OFF, SICK_DAY, STUDY_LEAVE, OTHER]
   *         from:
   *           type: string
   *           format: date
   *         to:
   *           type: string
   *           format: date
   *           description: The request's last pending day, inclusive.
   *         businessDays:
   *           type: integer
   *           description: |
   *             Days the range books, one per row. Weekends and holidays the
   *             request skipped between `from` and `to` are not counted.
   *         note:
   *           type: string
   *           nullable: true
   *           description: The first non-empty note among the range's rows.
   *         submittedAt:
   *           type: string
   *           format: date-time
   *           description: When the earliest row in the range was created.
   */
  app.get("/me/pending-requests", tryCatch(handleGetMyPendingRequests));

  /**
   * @openapi
   * /api/users/me/dashboard-summary:
   *   get:
   *     tags:
   *       - Users
   *     summary: Rolled-up dashboard counts for the caller
   *     description: |
   *       Out today, upcoming and team size cover every member of the groups
   *       the caller sees in full (View, admin access or manager). In a group
   *       without that access they count only the caller.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: today
   *         required: false
   *         schema:
   *           type: string
   *           format: date
   *         description: |
   *           The caller's own calendar day. Out today, working today and the
   *           14-day upcoming window count from it. Defaults to the server's
   *           UTC date.
   *     responses:
   *       '200':
   *         description: Stat-card counts
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 pendingApprovalsCount:
   *                   type: integer
   *                   description: Requests awaiting the caller's decision, grouped as in /api/users/me/approvals.
   *                 outTodayCount:
   *                   type: integer
   *                   description: Distinct people with approved time off today.
   *                 workingTodayCount:
   *                   type: integer
   *                   description: teamSize minus outTodayCount, never below 0.
   *                 upcomingNext14DaysCount:
   *                   type: integer
   *                   description: Approved days off from today through the next 13 days.
   *                 teamSize:
   *                   type: integer
   *                   description: Distinct live members counted.
   *       '400':
   *         description: "`today` is not a real YYYY-MM-DD date"
   *       '401':
   *         description: Not authenticated
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
   *       `attendanceLocationNoticeDismissed: false`, `language: null`).
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
   *       the caller must be able to read it in full, as `GET /api/vacation`
   *       requires: view access, admin access, being its manager, or
   *       administering it through its organization. That check runs only when
   *       the request sends `dashboardScope` or `dashboardGroupId`, so saving
   *       any other field succeeds even if the stored group is no longer
   *       viewable.
   *
   *       `dashboardCalendarView` picks how the dashboard month calendar draws
   *       leave: `LANES` (one bar per person, the default) or `STRIPES`
   *       (compact stripes with a day list). Every client reads the same value.
   *
   *       `language` is the web's active app language, `en` or `cs`; the web
   *       writes it whenever it differs from the stored value. `null` means
   *       English.
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
   *         description: |
   *           No access to view the selected group's records: the caller neither
   *           sees the group in full as a member nor administers it
   *       '422':
   *         description: |
   *           The body failed validation (no field supplied, or a value outside
   *           its enum, such as a `dashboardCalendarView` other than `LANES` or
   *           `STRIPES`, or a `language` other than `en`, `cs` or `null`), or
   *           group scope was requested without a group
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
   *         language:
   *           type: string
   *           enum: [en, cs]
   *           nullable: true
   *           description: |
   *             The person's app language, null meaning English. The `.ics`
   *             feed and direct calendar sync title the person's events with
   *             record type labels in this language.
   */
  app.get("/me/settings", tryCatch(handleGetMySettings));
  app.put(
    "/me/settings",
    bodyValidationMiddleware(validatePutUserSettings),
    tryCatch(handlePutMySettings)
  );

  /**
   * @openapi
   * /api/users/me/birthday:
   *   get:
   *     tags:
   *       - Users
   *     summary: The caller's birthday and who a shared birthday reaches
   *     description: |
   *       `birthday` is null until one is saved, and again after it is
   *       removed. Saving works on any plan.
   *
   *       `canShare` says whether `shared` may turn on: true while one of the
   *       caller's live groups belongs to an organization on a paid plan (Pro,
   *       Enterprise or Custom, grace included). Turning sharing off always
   *       works, and a switch already on stays on after every paid group has
   *       lapsed, so `birthday.shared` may be true while `canShare` is false.
   *
   *       `shareGroups` lists the caller's live groups whose organization is
   *       paid or lapsed (fell to Free from a plan or an override), the groups
   *       a shared birthday shows in today. A group that never paid is never
   *       listed. With a year set, whoever sees the birthday sees the age.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The birthday settings
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/BirthdaySettings'
   *       '401':
   *         description: Not signed in
   *   put:
   *     tags:
   *       - Users
   *     summary: Save the caller's birthday
   *     description: |
   *       Replaces the whole birthday, and brings back one that was removed.
   *       29 February is accepted with any year and shows on 28 February in
   *       other years. Only turning `shared` on from off asks the plan: it
   *       needs one of the caller's live groups on a paid plan. Sending
   *       `shared: false` always passes, and so does keeping a switch that is
   *       already on. Answers the same body as the read. Marks the caller's
   *       own direct-sync targets with Birthdays on, after the save.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [month, day, shared]
   *             properties:
   *               month:
   *                 type: integer
   *                 minimum: 1
   *                 maximum: 12
   *               day:
   *                 type: integer
   *                 minimum: 1
   *                 maximum: 31
   *                 description: Must exist in the month; 29 February counts.
   *               year:
   *                 type: integer
   *                 nullable: true
   *                 minimum: 1900
   *                 description: |
   *                   Optional, 1900 to the current year. Omitted or null means
   *                   no year, and then nobody sees an age.
   *               shared:
   *                 type: boolean
   *                 description: Show the birthday to the members of the caller's groups.
   *     responses:
   *       '200':
   *         description: The stored birthday settings
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/BirthdaySettings'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: |
   *           `shared` was turned on while none of the caller's live groups is
   *           on a paid plan. Nothing was saved. `errors[0].context` is
   *           `{ reason: "PLAN_LIMIT", code: "BIRTHDAY_SHARE_PLAN_REQUIRED" }`.
   *       '422':
   *         description: |
   *           The body failed validation: a month outside 1 to 12, a day the
   *           month never has (31 April, 30 February), a year before 1900 or
   *           in the future, a non-integer, or `shared` missing.
   *   delete:
   *     tags:
   *       - Users
   *     summary: Remove the caller's birthday
   *     description: |
   *       Wipes the month, day and year and turns sharing off. Answers 204
   *       whether or not a birthday was stored. Removing one marks the
   *       caller's own direct-sync targets with Birthdays on.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '204':
   *         description: No birthday remains
   *       '401':
   *         description: Not signed in
   * components:
   *   schemas:
   *     BirthdaySettings:
   *       type: object
   *       required: [birthday, canShare, shareGroups]
   *       properties:
   *         birthday:
   *           type: object
   *           nullable: true
   *           required: [month, day, year, shared]
   *           properties:
   *             month:
   *               type: integer
   *             day:
   *               type: integer
   *             year:
   *               type: integer
   *               nullable: true
   *             shared:
   *               type: boolean
   *         canShare:
   *           type: boolean
   *           description: Whether `shared` may turn on now.
   *         shareGroups:
   *           type: array
   *           description: The caller's paid and lapsed groups, by name.
   *           items:
   *             type: object
   *             required: [groupId, groupName]
   *             properties:
   *               groupId:
   *                 type: string
   *                 format: uuid
   *               groupName:
   *                 type: string
   */
  app.get("/me/birthday", tryCatch(handleGetMyBirthday));
  app.put(
    "/me/birthday",
    bodyValidationMiddleware(validatePutBirthday),
    tryCatch(handlePutMyBirthday)
  );
  app.delete("/me/birthday", tryCatch(handleDeleteMyBirthday));

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
   * /api/users/me/export:
   *   get:
   *     tags:
   *       - Users
   *     summary: Download the caller's Account export
   *     description: |
   *       The account data Flexi Day holds about the caller as controller, as
   *       one JSON file built in this request: the account itself, its sign-in
   *       methods, sessions and devices, push registrations, settings,
   *       Birthday, notifications, calendar connections and calendar feeds.
   *
   *       It never holds a token, a password hash, a two-factor secret or
   *       backup code, a calendar feed link, or an APNs device token: sign-in
   *       methods, calendar connections and push registrations carry dates
   *       instead. Organization data (bookings, attendance, Employments) is not
   *       in it; the organization exports that.
   *
   *       Works on every plan, with a web cookie or a Native session. Sent
   *       with `Content-Disposition: attachment` and `Cache-Control: no-store`.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The Account export
   *         headers:
   *           Content-Disposition:
   *             description: '`attachment; filename="flexi-day-account-YYYY-MM-DD.json"`, dated in UTC'
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AccountExport'
   *       '401':
   *         description: Not signed in
   * components:
   *   schemas:
   *     AccountExport:
   *       type: object
   *       required:
   *         - format
   *         - version
   *         - exportedAt
   *         - account
   *         - signInMethods
   *         - sessions
   *         - pushRegistrations
   *         - settings
   *         - birthday
   *         - notifications
   *         - calendarConnections
   *         - calendarFeeds
   *       properties:
   *         format:
   *           type: string
   *           enum: [flexi-day-account-export]
   *         version:
   *           type: integer
   *           enum: [1]
   *         exportedAt:
   *           type: string
   *           format: date-time
   *         account:
   *           type: object
   *           required: [id, name, email, emailVerified, image, twoFactorEnabled, createdAt, updatedAt]
   *           properties:
   *             id:
   *               type: string
   *             name:
   *               type: string
   *             email:
   *               type: string
   *               format: email
   *             emailVerified:
   *               type: boolean
   *             image:
   *               type: string
   *               nullable: true
   *               description: The Account picture's URL.
   *             twoFactorEnabled:
   *               type: boolean
   *             createdAt:
   *               type: string
   *               format: date-time
   *             updatedAt:
   *               type: string
   *               format: date-time
   *         signInMethods:
   *           type: array
   *           description: One entry per Account link, the password included as `credential`.
   *           items:
   *             type: object
   *             required: [providerId, accountId, createdAt, updatedAt]
   *             properties:
   *               providerId:
   *                 type: string
   *                 example: google
   *               accountId:
   *                 type: string
   *                 description: The caller's id at the provider.
   *               createdAt:
   *                 type: string
   *                 format: date-time
   *               updatedAt:
   *                 type: string
   *                 format: date-time
   *         sessions:
   *           type: array
   *           items:
   *             type: object
   *             required: [current, createdAt, updatedAt, expiresAt, ipAddress, userAgent, deviceId, platform, appVersion]
   *             properties:
   *               current:
   *                 type: boolean
   *                 description: True for the session that asked for this export.
   *               createdAt:
   *                 type: string
   *                 format: date-time
   *               updatedAt:
   *                 type: string
   *                 format: date-time
   *               expiresAt:
   *                 type: string
   *                 format: date-time
   *               ipAddress:
   *                 type: string
   *                 nullable: true
   *               userAgent:
   *                 type: string
   *                 nullable: true
   *               deviceId:
   *                 type: string
   *                 nullable: true
   *                 description: The Device id of a Native session, null on the web.
   *               platform:
   *                 type: string
   *                 nullable: true
   *               appVersion:
   *                 type: string
   *                 nullable: true
   *         pushRegistrations:
   *           type: array
   *           items:
   *             type: object
   *             required: [environment, deviceId, platform, createdAt, updatedAt]
   *             properties:
   *               environment:
   *                 type: string
   *                 enum: [sandbox, production]
   *               deviceId:
   *                 type: string
   *                 nullable: true
   *               platform:
   *                 type: string
   *                 nullable: true
   *               createdAt:
   *                 type: string
   *                 format: date-time
   *               updatedAt:
   *                 type: string
   *                 format: date-time
   *         settings:
   *           $ref: '#/components/schemas/UserSettings'
   *         birthday:
   *           type: object
   *           nullable: true
   *           description: Null when never set. A removed Birthday keeps its dates with month, day and year null.
   *           required: [month, day, year, shared, createdAt, updatedAt, deletedAt]
   *           properties:
   *             month:
   *               type: integer
   *               nullable: true
   *             day:
   *               type: integer
   *               nullable: true
   *             year:
   *               type: integer
   *               nullable: true
   *             shared:
   *               type: boolean
   *             createdAt:
   *               type: string
   *               format: date-time
   *             updatedAt:
   *               type: string
   *               format: date-time
   *             deletedAt:
   *               type: string
   *               format: date-time
   *               nullable: true
   *         notifications:
   *           type: array
   *           description: Every Notification, read and unread, oldest first.
   *           items:
   *             type: object
   *             required: [type, title, body, href, readAt, createdAt]
   *             properties:
   *               type:
   *                 type: string
   *               title:
   *                 type: string
   *               body:
   *                 type: string
   *               href:
   *                 type: string
   *                 nullable: true
   *               readAt:
   *                 type: string
   *                 format: date-time
   *                 nullable: true
   *               createdAt:
   *                 type: string
   *                 format: date-time
   *         calendarConnections:
   *           type: array
   *           description: Every Calendar connection, revoked ones included.
   *           items:
   *             type: object
   *             required: [provider, status, capability, grantedScopes, lastErrorAt, revokedAt, createdAt, updatedAt]
   *             properties:
   *               provider:
   *                 type: string
   *                 enum: [GOOGLE, MICROSOFT]
   *               status:
   *                 type: string
   *                 enum: [ACTIVE, NEEDS_RECONNECT]
   *               capability:
   *                 type: string
   *                 enum: [UNKNOWN, STATUS, PLAIN]
   *               grantedScopes:
   *                 type: string
   *               lastErrorAt:
   *                 type: string
   *                 format: date-time
   *                 nullable: true
   *               revokedAt:
   *                 type: string
   *                 format: date-time
   *                 nullable: true
   *               createdAt:
   *                 type: string
   *                 format: date-time
   *               updatedAt:
   *                 type: string
   *                 format: date-time
   *         calendarFeeds:
   *           type: array
   *           description: Every calendar feed and Sync target, deleted ones included, without the feed link.
   *           items:
   *             type: object
   *             required: [name, scope, timeZone, includeGroupEvents, includeBirthdays, syncsTo, lastFetchedAt, lastSyncedAt, deletedAt, createdAt, updatedAt]
   *             properties:
   *               name:
   *                 type: string
   *               scope:
   *                 type: string
   *                 enum: [ME, TEAM]
   *               timeZone:
   *                 type: string
   *               includeGroupEvents:
   *                 type: boolean
   *               includeBirthdays:
   *                 type: boolean
   *               syncsTo:
   *                 type: string
   *                 enum: [GOOGLE, MICROSOFT]
   *                 nullable: true
   *                 description: The provider a Sync target writes to, null for a plain feed.
   *               lastFetchedAt:
   *                 type: string
   *                 format: date-time
   *                 nullable: true
   *               lastSyncedAt:
   *                 type: string
   *                 format: date-time
   *                 nullable: true
   *               deletedAt:
   *                 type: string
   *                 format: date-time
   *                 nullable: true
   *               createdAt:
   *                 type: string
   *                 format: date-time
   *               updatedAt:
   *                 type: string
   *                 format: date-time
   */
  app.get("/me/export", tryCatch(handleGetMyAccountExport));

  /**
   * @openapi
   * /api/users/me/delete:
   *   post:
   *     tags:
   *       - Users
   *     summary: Delete the caller's account
   *     description: |
   *       Once the confirmation passes and no blocker applies, each live
   *       calendar connection is disconnected before the transaction: the
   *       events it wrote are deleted at the provider and its Google grant is
   *       revoked. This step is best effort; a failure is logged and does not
   *       fail the request.
   *
   *       Hard-deletes the account in one transaction: the user and everything
   *       that hangs off them, the groups they manage and the organizations
   *       they own (both only possible once nobody else is in them), with
   *       their subscription rows. The caller is cleared from main and temp
   *       approver slots of other people's groups, and quota changes they
   *       made stay with a deleted-actor marker. Stored attachment objects
   *       are removed after the commit; a failure there is logged and does not
   *       fail the request. Each Apple account link is then revoked at Apple
   *       with the refresh token read before the transaction; a link without
   *       one, or a revoke Apple refuses, is logged and does not fail the
   *       request either. Every session ends, web and Native, so the old
   *       cookie answers 401 afterwards. Every refusal, a wrong password
   *       included, spends the same failures-only rate limit as sign-in. The
   *       full policy is in `docs/account-deletion.md`.
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
   *           At least one blocker applies, and the account is kept. A
   *           blocker that appears after the calendar step still refuses the
   *           deletion, with the calendars already disconnected.
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
   *       '429':
   *         description: Too many failed attempts from this address
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

  /**
   * @openapi
   * /api/users/me/push-registration:
   *   put:
   *     tags:
   *       - Users
   *     summary: Register the phone's APNs token for push
   *     description: |
   *       Binds an APNs device token to the caller's Native session (ADR 0006).
   *       The phone calls this on every foreground while it is signed in and
   *       has notification permission, so it is idempotent: a repeat with the
   *       same token and environment changes nothing, and a new token or
   *       environment replaces the stored one.
   *
   *       A token belongs to one app install, so another session still holding
   *       the same token loses it. The registration ends with its session,
   *       whatever ends it: sign-out, a new sign-in on the same phone, a
   *       password change or reset, a two-factor toggle, account deletion, or
   *       a changed Better Auth secret at boot. Native session only: a web
   *       session has no token to give.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [token, environment]
   *             properties:
   *               token:
   *                 type: string
   *                 pattern: '^([0-9a-fA-F]{2}){32,100}$'
   *                 description: |
   *                   The device token from `getDevicePushTokenAsync()`, in hex,
   *                   32 to 100 bytes. Stored in lower case.
   *               environment:
   *                 type: string
   *                 enum: [sandbox, production]
   *                 description: |
   *                   The APNs environment the token was issued for. A debug
   *                   build's token only works on `sandbox`, a TestFlight or
   *                   App Store build's only on `production`.
   *     responses:
   *       '204':
   *         description: Registered, or already registered with the same values.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           A web session, and nothing changed. Checked before the body, so a
   *           web session gets this whatever it sends. `errors[0].context.reason`
   *           is `NATIVE_SESSION_REQUIRED`.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NativeSessionRequiredError'
   *       '422':
   *         description: |
   *           A Native session sent a body that failed validation: `token`
   *           missing or not 32 to 100 bytes of hex, or `environment` other than
   *           `sandbox` or `production`.
   *   delete:
   *     tags:
   *       - Users
   *     summary: Remove the phone's push registration
   *     description: |
   *       The phone calls this when it finds notification permission revoked.
   *       Deletes the registration of the caller's Native session, and answers
   *       204 whether or not one existed. Native session only.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '204':
   *         description: No registration remains for this session.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           A web session, and nothing changed. `errors[0].context.reason`
   *           is `NATIVE_SESSION_REQUIRED`.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NativeSessionRequiredError'
   * components:
   *   schemas:
   *     NativeSessionRequiredError:
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
   *                     enum: [NATIVE_SESSION_REQUIRED]
   */
  app.put(
    "/me/push-registration",
    requireNativeSession,
    bodyValidationMiddleware(validatePutPushRegistration),
    tryCatch(handlePutPushRegistration)
  );
  app.delete("/me/push-registration", requireNativeSession, tryCatch(handleDeletePushRegistration));

  return app;
};
