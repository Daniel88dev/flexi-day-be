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
   *       Group scope requires view access on that group (view access, admin
   *       access, or being its manager); a plain member gets a 403.
   *       Each row includes a denormalized `user` summary used by the calendar UI,
   *       and `canApprove` — the same verdict the decision endpoints enforce, so
   *       a client can render the action without re-deriving the rule.
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
   *         description: No access to view this group's records
   *       '500':
   *         description: Internal Server Error
   * components:
   *   schemas:
   *     UserSummary:
   *       type: object
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
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
   *             canApprove:
   *               type: boolean
   *               description: Whether the caller may decide on this request right now.
   */
  app.get("/", tryCatch(handleGetVacations));

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
   *       '403':
   *         description: Not allowed to view this vacation
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
   *       server fans the range out into one row per day, skipping any days the
   *       user already has a vacation for (unique on user + day).
   *
   *       Admins may book on behalf of a member by passing `userId`: the caller
   *       must hold group admin access or administer the group's organization,
   *       and the member must be allowed to book in the group. `createdByUserId`
   *       records who filed the request. With `autoApprove` (valid only
   *       together with `userId`) the rows are created already approved by the
   *       caller and the timeline gets both a CREATED and an APPROVED event;
   *       without it the request enters the normal approval flow and the member
   *       is notified it was filed for them.
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
   *       '422':
   *         description: Validation error
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
   *           format: uuid
   *         groupId:
   *           type: string
   *           format: uuid
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
   *       Used together with `/api/users/me/approvals`, which returns
   *       contiguous day rows collapsed into a single approval entry whose
   *       `vacationIds` array names every row in the range. Sending that
   *       array here guarantees the whole range is approved together or not
   *       at all.
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
   *       decision. Any caller who can view the request may comment. The other
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
   *         description: Not allowed to view this vacation
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
   *       `vacationType` and `note`. Requires group admin access, or admin of
   *       the group's organization. All ids must belong to the same member and
   *       group; the detail view passes a whole contiguous run so it is edited
   *       atomically. Dates are deliberately not editable — moving a record to
   *       another day is a cancel + re-create, both audited.
   *
   *       Rejected rows cannot be edited (their decision is final) and
   *       cancelled rows are reported as not found. Type and half-day changes
   *       re-run the quota check at the rows' post-edit weight. Every row gets
   *       an UPDATED timeline event whose `reason` summarizes what changed, and
   *       the member gets an in-app notice when someone else edited their
   *       record.
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
   *         description: Validation error, mixed members/groups, or the edit exceeds the allowance
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
