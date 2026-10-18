import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetVacations } from "../controllers/vacation/handleGetVacations.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validateApproveVacation,
  validateBulkApproveVacation,
  validateBulkCancelVacation,
  validateBulkRejectVacation,
  validateCancelVacation,
  validateCommentVacation,
  validatePostVacation,
  validateRejectVacation,
  validateUpdateVacation,
} from "../services/vacation/types.js";
import { handleGetVacation } from "../controllers/vacation/handleGetVacation.js";
import { handlePostVacation } from "../controllers/vacation/handlePostVacation.js";
import { handlePostVacationApproval } from "../controllers/vacation/handlePostVacationApproval.js";
import { handlePostVacationReject } from "../controllers/vacation/handlePostVacationReject.js";
import { handlePostVacationComment } from "../controllers/vacation/handlePostVacationComment.js";
import { handleDeleteVacation } from "../controllers/vacation/handleDeleteVacation.js";
import { handleBulkApproveVacation } from "../controllers/vacation/handleBulkApproveVacation.js";
import { handleBulkRejectVacation } from "../controllers/vacation/handleBulkRejectVacation.js";
import { handleBulkCancelVacation } from "../controllers/vacation/handleBulkCancelVacation.js";
import { handleUpdateVacation } from "../controllers/vacation/handleUpdateVacation.js";
import { handleGetVacationCalendar } from "../controllers/vacation/handleGetVacationCalendar.js";

export const vacationRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/vacation:
   *   get:
   *     tags:
   *       - Vacations
   *     summary: Retrieve vacations for the authenticated user or one of their groups
   *     description: |
   *       Returns vacation records for a given year and month. Without `groupId`
   *       the caller's own records are returned. With `groupId` the whole
   *       group's records are returned instead — including records mirrored into
   *       it from another group, which carry a non-null `mirroredFromGroupId`.
   *
   *       Group scope requires seeing the whole group: view access, admin
   *       access, being its manager, or administering it through its
   *       organization, member or not (the groups `GET /api/reports/scope`
   *       lists with `access: "all"`). A plain member, or anyone outside the
   *       group, gets a 403. Reading a group never grants deciding in it:
   *       `canApprove` stays approver-only, so an org admin sees `false`.
   *       Each row includes a denormalized `user` summary used by the calendar UI,
   *       and `canApprove` — the same verdict the decision endpoints enforce, so
   *       a client can render the action without re-deriving the rule.
   *
   *       In group scope each row is shaped for the caller. The owner and the
   *       approvers and group admins of the row's own group (`groupId`, never
   *       the group being listed) get it in full. Anyone else gets the teammate
   *       view: `SICK` reads as `AWAY`, and `note`, `rejectionReason`,
   *       `rejectedBy` and `deletedByUserId` are null. Other people's rejected
   *       and cancelled rows are left out of the teammate view entirely. A
   *       row mirrored in from another group gets the teammate view here, even
   *       for this group's approvers and admins.
   *     operationId: handleGetVacations
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: year
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 2023
   *           maximum: 2050
   *       - name: month
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 12
   *       - name: groupId
   *         in: query
   *         required: false
   *         description: Return this group's records instead of the caller's own.
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: includeCancelled
   *         in: query
   *         required: false
   *         description: |
   *           When `true`, cancelled (soft-deleted) rows are included so the
   *           requests view can show them with their `deletedAt` /
   *           `deletedByUserId` stamps. Defaults to `false`, keeping the
   *           calendar and dashboard on live rows only.
   *         schema:
   *           type: string
   *           enum: ["true", "false"]
   *     responses:
   *       '200':
   *         description: Array of vacations matching the query
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/VacationListItem'
   *       '401':
   *         description: Unauthorized
   *       '403':
   *         description: |
   *           No access to view this group's records: the caller neither sees the
   *           group in full as a member nor administers it
   *       '500':
   *         description: Internal Server Error
   * components:
   *   schemas:
   *     UserSummary:
   *       type: object
   *       properties:
   *         id:
   *           type: string
   *         name:
   *           type: string
   *         initials:
   *           type: string
   *         avatarColor:
   *           type: string
   *     VacationListItem:
   *       allOf:
   *         - $ref: '#/components/schemas/Vacation'
   *         - type: object
   *           properties:
   *             user:
   *               $ref: '#/components/schemas/UserSummary'
   *             mirroredFromGroupId:
   *               type: string
   *               format: uuid
   *               nullable: true
   *               description: Set when the record belongs to another group and is only projected here.
   *             mirroredFromGroupName:
   *               type: string
   *               nullable: true
   *             vacationType:
   *               type: string
   *               enum:
   *                 - VACATION
   *                 - HOME_OFFICE
   *                 - SICK
   *                 - NON_PAID_LEAVE
   *                 - PAID_TIME_OFF
   *                 - SICK_DAY
   *                 - STUDY_LEAVE
   *                 - OTHER
   *                 - BANK_HOLIDAY
   *                 - AWAY
   *               description: |
   *                 `AWAY` is response-only: a teammate's view of a `SICK` row.
   *                 It is never stored and no write accepts it.
   *             canApprove:
   *               type: boolean
   *               description: Whether the caller may decide on this request right now.
   */
  app.get("/", tryCatch(handleGetVacations));

  /**
   * @openapi
   * /api/vacation/calendar:
   *   get:
   *     tags:
   *       - Vacations
   *     summary: Retrieve the dashboard calendar's vacations for a month plus 6 days either side
   *     description: |
   *       Returns the live vacation records the dashboard month calendar draws:
   *       from 6 days before the 1st of the month through 6 days after its last
   *       day, so the leading and trailing days of the neighbouring months in
   *       the first and last week carry their records. The window crosses a
   *       year boundary as needed: December 2026 reaches 6 January 2027, and
   *       January 2027 starts on 26 December 2026.
   *
   *       Scope, access and row shape are those of `GET /api/vacation`. Without
   *       `groupId` the caller's own records are returned; with it the whole
   *       group's, mirrored records included. Group scope needs the same
   *       standing as there: view access, admin access, being its manager, or
   *       administering it through its organization, member or not. A plain
   *       member, or anyone outside the group, gets a 403. Cancelled rows are
   *       never included. Rows get the same teammate view as there: `SICK` as
   *       `AWAY`, Private details null, no rejected rows of other people.
   *     operationId: handleGetVacationCalendar
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: year
   *         in: query
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 2023
   *           maximum: 2050
   *       - name: month
   *         in: query
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 12
   *       - name: groupId
   *         in: query
   *         required: false
   *         description: Return this group's records instead of the caller's own.
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: Live vacations in the padded window, ordered by day
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/VacationListItem'
   *       '401':
   *         description: Unauthorized
   *       '403':
   *         description: |
   *           No access to view this group's records: the caller neither sees the
   *           group in full as a member nor administers it
   *       '422':
   *         description: Missing or out-of-range `year` or `month`
   *       '500':
   *         description: Internal Server Error
   */
  app.get("/calendar", tryCatch(handleGetVacationCalendar));

  /**
   * @openapi
   * /api/vacation/{id}:
   *   get:
   *     tags:
   *       - Vacations
   *     summary: Retrieve one vacation with its history
   *     description: |
   *       Returns the request enriched with the requester, the group name, the
   *       decision makers, who created it (`createdByUser` — an admin when it
   *       was booked on the member's behalf) and who cancelled it
   *       (`deletedByUser`), the append-only event timeline (created, approved,
   *       rejected, cancelled, updated), and the actions this caller may take
   *       (`canApprove`, `canCancel`, `canEdit`). Cancelled requests remain
   *       retrievable so the timeline can explain what happened to them.
   *
   *       For the record owner, the group's approvers and its group and
   *       organization admins the payload also carries `attachments` (every
   *       attachment of the Request, any status, deleted ones included with
   *       `deletedAt` and `deletedByUserId` set), `canAttach`, which is
   *       true only when the caller may add one, the plan allows uploads and
   *       the Request has a free slot, and `canDeleteAnyAttachment`, true for
   *       group and organization admins, who may delete files they did not
   *       upload. A member with view access only gets none of the three.
   *
   *       Those same readers, the privileged readers of the row's own group,
   *       get `canReadPrivateDetails: true` and the full row. Anyone else who
   *       may view it gets the teammate view: `SICK` as `AWAY`, `note`,
   *       `rejectionReason`, `rejectedBy`, `rejectedByUser`, `deletedByUserId`
   *       and `deletedByUser` null, `history` empty, and
   *       `canReadPrivateDetails: false`. Another person's rejected or
   *       cancelled request answers them with the same 403 as a request they
   *       may not view.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The vacation, its history and the caller's permissions
   *         content:
   *           application/json:
   *             schema:
   *               allOf:
   *                 - $ref: '#/components/schemas/VacationListItem'
   *                 - type: object
   *                   properties:
   *                     groupName:
   *                       type: string
   *                     approvedByUser:
   *                       allOf:
   *                         - $ref: '#/components/schemas/UserSummary'
   *                       nullable: true
   *                     rejectedByUser:
   *                       allOf:
   *                         - $ref: '#/components/schemas/UserSummary'
   *                       nullable: true
   *                     createdByUser:
   *                       allOf:
   *                         - $ref: '#/components/schemas/UserSummary'
   *                       nullable: true
   *                       description: An admin when the request was booked on the member's behalf.
   *                     deletedByUser:
   *                       allOf:
   *                         - $ref: '#/components/schemas/UserSummary'
   *                       nullable: true
   *                     rangeStart:
   *                       type: string
   *                       format: date
   *                       description: |
   *                         First day of the Request this row belongs to, counting only
   *                         its rows in the same state (pending, approved, rejected or
   *                         cancelled) as this one. Days the Request skips, such as a
   *                         weekend or public holiday, do not split it.
   *                     rangeEnd:
   *                       type: string
   *                       format: date
   *                       description: Last day of those same rows.
   *                     vacationIds:
   *                       type: array
   *                       description: |
   *                         Every row of this row's Request in the same state, this one
   *                         included. The decide, cancel and edit endpoints take this list
   *                         to act on the whole Request.
   *                       items:
   *                         type: string
   *                         format: uuid
   *                     canCancel:
   *                       type: boolean
   *                     canEdit:
   *                       type: boolean
   *                     canReadPrivateDetails:
   *                       type: boolean
   *                       description: |
   *                         True for the owner and the approvers and group admins
   *                         of the row's own group. They alone see the note,
   *                         rejection reason and history, and may comment.
   *                     history:
   *                       type: array
   *                       description: The append-only event timeline, oldest first. Empty when `canReadPrivateDetails` is false.
   *                       items:
   *                         type: object
   *                         properties:
   *                           id:
   *                             type: string
   *                             format: uuid
   *                           vacationId:
   *                             type: string
   *                             format: uuid
   *                           eventType:
   *                             type: string
   *                             enum: [CREATED, APPROVED, REJECTED, CANCELLED, COMMENT, UPDATED]
   *                           actorUserId:
   *                             type: string
   *                             nullable: true
   *                           actorName:
   *                             type: string
   *                             nullable: true
   *                           reason:
   *                             type: string
   *                             nullable: true
   *                           createdAt:
   *                             type: string
   *                             format: date-time
   *                     attachments:
   *                       type: array
   *                       description: Present only for the owner, approvers and admins.
   *                       items:
   *                         $ref: '#/components/schemas/Attachment'
   *                     canAttach:
   *                       type: boolean
   *                       description: Present only for the owner, approvers and admins.
   *                     canDeleteAnyAttachment:
   *                       type: boolean
   *                       description: Present only for the owner, approvers and admins; true for group and organization admins.
   *       '403':
   *         description: |
   *           Not allowed to view this vacation, or it is another person's
   *           rejected or cancelled request and the caller may not read its
   *           Private details
   *       '404':
   *         description: Vacation not found
   */
  app.get("/:id", tryCatch(handleGetVacation));

  /**
   * @openapi
   * /api/vacation/create-vacation:
   *   post:
   *     tags:
   *       - Vacations
   *     summary: Create a vacation request for a date range
   *     description: |
   *       Creates a vacation request that spans an inclusive `from`/`to` range. The
   *       server fans the range out into one row per day. A requested working day
   *       that already holds a live vacation (unique on user + day) rejects the
   *       whole request with 409. Days outside the group's `workingDays` and
   *       public holidays of the group's `holidayCountry` are skipped, so they
   *       never count against an allowance. A range in which every day is a
   *       non-working day or a public holiday is rejected with 422.
   *
   *       Admins may book on behalf of a member by passing `userId`: the caller
   *       must hold group admin access, manage the group, or administer the
   *       group's organization,
   *       and the member must be allowed to book in the group. `createdByUserId`
   *       records who filed the request. With `autoApprove` (valid only
   *       together with `userId`) the rows are created already approved by the
   *       caller and the timeline gets both a CREATED and an APPROVED event;
   *       without it the request enters the normal approval flow and the member
   *       is notified it was filed for them.
   *
   *       `SICK_DAY` is requestable only while the group's organization has
   *       the Sick day benefit enabled on a paid plan; otherwise the request
   *       is rejected with 422.
   *     operationId: handlePostVacation
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PostVacation'
   *     responses:
   *       '201':
   *         description: One or more vacation rows created
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Vacation'
   *       '401':
   *         description: Unauthorized
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: No access for related group
   *       '409':
   *         description: |
   *           One or more requested days are already booked (a day held only
   *           by cancelled or rejected rows is free). Nothing from the request
   *           is created. `errors[].context` carries `{ conflictingDays }`, the
   *           requested dates that conflict, as an array of `YYYY-MM-DD` date
   *           strings.
   *       '422':
   *         description: |
   *           Validation error, the range holds no working day (every day is a
   *           non-working day or a public holiday), the allowance would be
   *           exceeded, or `SICK_DAY` was requested without an active Sick day
   *           benefit (`errors[].context.reason: "SICK_DAY_BENEFIT_DISABLED"`).
   *       '500':
   *         description: Failed to create vacation
   * components:
   *   schemas:
   *     PostVacation:
   *       type: object
   *       required:
   *         - groupId
   *         - from
   *         - to
   *       properties:
   *         groupId:
   *           type: string
   *           format: uuid
   *         userId:
   *           type: string
   *           description: Book on behalf of this member (admins only).
   *         from:
   *           type: string
   *           format: date
   *         to:
   *           type: string
   *           format: date
   *         vacationType:
   *           type: string
   *           enum:
   *             - VACATION
   *             - HOME_OFFICE
   *             - SICK
   *             - NON_PAID_LEAVE
   *             - PAID_TIME_OFF
   *             - SICK_DAY
   *             - STUDY_LEAVE
   *             - OTHER
   *         startTime:
   *           type: string
   *           nullable: true
   *         endTime:
   *           type: string
   *           nullable: true
   *         note:
   *           type: string
   *           nullable: true
   *           description: Required (non-blank) when `vacationType` is `OTHER`.
   *         autoApprove:
   *           type: boolean
   *           description: Create the rows already approved (on-behalf bookings only).
   *     Vacation:
   *       type: object
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         userId:
   *           type: string
   *         groupId:
   *           type: string
   *           format: uuid
   *         requestId:
   *           type: string
   *           format: uuid
   *           description: |
   *             Shared by every day row created in the same submission, so a
   *             client can group a range back into one request.
   *         requestedDay:
   *           type: string
   *           format: date
   *         note:
   *           type: string
   *           nullable: true
   *         createdAt:
   *           type: string
   *           format: date-time
   *         updatedAt:
   *           type: string
   *           format: date-time
   */
  app.post(
    "/create-vacation",
    bodyValidationMiddleware(validatePostVacation),
    tryCatch(handlePostVacation)
  );

  /**
   * @openapi
   * /api/vacation/approve/{id}:
   *   post:
   *     tags:
   *       - Vacations
   *     summary: Approve a vacation request
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               reason:
   *                 type: string
   *     responses:
   *       '200':
   *         description: Vacation approved
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   */
  app.post(
    "/approve/:id",
    bodyValidationMiddleware(validateApproveVacation),
    tryCatch(handlePostVacationApproval)
  );

  /**
   * @openapi
   * /api/vacation/approve:
   *   post:
   *     tags:
   *       - Vacations
   *     summary: Atomically approve many vacation rows in one transaction
   *     description: |
   *       Used together with `/api/users/me/approvals`, which returns the
   *       pending days of each request collapsed into a single approval entry
   *       whose `vacationIds` array names every still-pending row of the
   *       request. Sending that array here guarantees those rows are approved
   *       together or not at all.
   *
   *       An optional `reason` is stored on every approval event and shown in
   *       the request history. The approval notification does not carry it.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - ids
   *             properties:
   *               ids:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *               reason:
   *                 type: string
   *                 maxLength: 1000
   *     responses:
   *       '200':
   *         description: All requested vacations approved
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: Not allowed to approve one or more rows
   *       '404':
   *         description: One or more vacations not found
   *       '409':
   *         description: One or more of the requests has already been decided
   *       '422':
   *         description: Invalid body, e.g. a `reason` longer than 1000 characters
   */
  app.post(
    "/approve",
    bodyValidationMiddleware(validateBulkApproveVacation),
    tryCatch(handleBulkApproveVacation)
  );

  /**
   * @openapi
   * /api/vacation/reject/{id}:
   *   post:
   *     tags:
   *       - Vacations
   *     summary: Reject a vacation request
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               reason:
   *                 type: string
   *     responses:
   *       '200':
   *         description: Vacation rejected
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   */
  app.post(
    "/reject/:id",
    bodyValidationMiddleware(validateRejectVacation),
    tryCatch(handlePostVacationReject)
  );

  /**
   * @openapi
   * /api/vacation/comment/{id}:
   *   post:
   *     tags:
   *       - Vacations
   *     summary: Add a comment to a vacation request
   *     description: |
   *       Appends a comment to the request timeline without changing its
   *       decision. Only the owner and the approvers and group admins of the
   *       request's own group may comment (`canReadPrivateDetails` on
   *       `GET /api/vacation/{id}`). The other
   *       party — the request owner, or the group's approvers when the owner
   *       comments — is notified by email and in-app.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
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
   *               - message
   *             properties:
   *               message:
   *                 type: string
   *     responses:
   *       '200':
   *         description: Comment added
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: |
   *           Not allowed to comment: the caller is not the owner, nor an
   *           approver or group admin of the request's group
   *       '404':
   *         description: Vacation not found
   */
  app.post(
    "/comment/:id",
    bodyValidationMiddleware(validateCommentVacation),
    tryCatch(handlePostVacationComment)
  );

  /**
   * @openapi
   * /api/vacation/reject:
   *   post:
   *     tags:
   *       - Vacations
   *     summary: Atomically reject many vacation rows in one transaction
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - ids
   *             properties:
   *               ids:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *               reason:
   *                 type: string
   *     responses:
   *       '200':
   *         description: All requested vacations rejected
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: Not allowed to reject one or more rows
   *       '404':
   *         description: One or more vacations not found
   */
  app.post(
    "/reject",
    bodyValidationMiddleware(validateBulkRejectVacation),
    tryCatch(handleBulkRejectVacation)
  );

  /**
   * @openapi
   * /api/vacation/cancel:
   *   post:
   *     tags:
   *       - Vacations
   *     summary: Atomically cancel (soft delete) many vacation rows in one transaction
   *     description: |
   *       Cancels every supplied day id together — used by the detail view to
   *       cancel a whole multi-day request at once. The caller must, for every
   *       row, be the owner, a group admin, an admin of the group's
   *       organization, or an approver of its group. Each row is stamped with
   *       `deletedByUserId`, and an optional `reason` is stored on each
   *       cancellation event.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - ids
   *             properties:
   *               ids:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *               reason:
   *                 type: string
   *     responses:
   *       '200':
   *         description: All requested vacations cancelled
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: Not allowed to cancel one or more rows
   *       '404':
   *         description: One or more vacations not found
   *       '409':
   *         description: |
   *           A concurrent cancel won the race for one or more rows. The whole
   *           batch is refused — nothing is cancelled.
   */
  app.post(
    "/cancel",
    bodyValidationMiddleware(validateBulkCancelVacation),
    tryCatch(handleBulkCancelVacation)
  );

  /**
   * @openapi
   * /api/vacation:
   *   patch:
   *     tags:
   *       - Vacations
   *     summary: Edit per-day fields of one member's vacation rows (admins only)
   *     description: |
   *       In-place edit of existing day rows: `startTime`/`endTime`, `halfDay`,
   *       `vacationType` and `note`. Requires group admin access, being the
   *       group's manager, or admin of the group's organization. All ids must
   *       belong to the same member and
   *       group; the detail view passes its whole Request so it is edited
   *       atomically. Dates are deliberately not editable — moving a record to
   *       another day is a cancel + re-create, both audited.
   *
   *       Rejected rows cannot be edited (their decision is final) and
   *       cancelled rows are reported as not found. Type and half-day changes
   *       re-run the quota check at the rows' post-edit weight, and retyping a
   *       row to `SICK_DAY` passes the same Sick day benefit gate as creating
   *       one. Every row gets an UPDATED timeline event whose `reason`
   *       summarizes what changed, and the member gets an in-app notice when
   *       someone else edited their record.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - ids
   *             properties:
   *               ids:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *               vacationType:
   *                 type: string
   *                 enum:
   *                   - VACATION
   *                   - HOME_OFFICE
   *                   - SICK
   *                   - NON_PAID_LEAVE
   *                   - PAID_TIME_OFF
   *                   - SICK_DAY
   *                   - STUDY_LEAVE
   *                   - OTHER
   *               startTime:
   *                 type: string
   *                 nullable: true
   *               endTime:
   *                 type: string
   *                 nullable: true
   *               halfDay:
   *                 type: boolean
   *                 description: Only valid when editing a single day row.
   *               note:
   *                 type: string
   *                 nullable: true
   *     responses:
   *       '200':
   *         description: The updated vacation rows
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Vacation'
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: Not a group or organization admin for these records
   *       '404':
   *         description: One or more vacations not found (cancelled rows included)
   *       '409':
   *         description: Rejected rows in the batch, or a concurrent change won the race
   *       '422':
   *         description: |
   *           Validation error, mixed members/groups, the edit exceeds the
   *           allowance, or a retype to `SICK_DAY` without an active Sick day
   *           benefit (`errors[].context.reason: "SICK_DAY_BENEFIT_DISABLED"`).
   */
  app.patch("/", bodyValidationMiddleware(validateUpdateVacation), tryCatch(handleUpdateVacation));

  /**
   * @openapi
   * /api/vacation/{id}:
   *   delete:
   *     tags:
   *       - Vacations
   *     summary: Cancel (soft delete) a vacation request
   *     description: |
   *       Soft deletes the vacation row by setting `deletedAt` and stamping
   *       `deletedByUserId` with the caller, including already-approved
   *       requests. The caller must own the row, or be a group admin, an
   *       organization admin, or an approver of the parent group. An optional
   *       `reason` is stored on the cancellation event; the row stays
   *       retrievable on the detail view and in lists via `includeCancelled`.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               reason:
   *                 type: string
   *     responses:
   *       '200':
   *         description: Vacation cancelled
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: Not allowed
   *       '404':
   *         description: Vacation not found
   *       '409':
   *         description: A concurrent cancel won the race; the row is already cancelled
   */
  app.delete(
    "/:id",
    bodyValidationMiddleware(validateCancelVacation),
    tryCatch(handleDeleteVacation)
  );

  return app;
};
