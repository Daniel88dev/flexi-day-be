import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetVacations } from "../controllers/vacation/handleGetVacations.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validateBulkApproveVacation,
  validateBulkRejectVacation,
  validatePostVacation,
  validateRejectVacation,
} from "../services/vacation/types.js";
import { handlePostVacation } from "../controllers/vacation/handlePostVacation.js";
import { handlePostVacationApproval } from "../controllers/vacation/handlePostVacationApproval.js";
import { handlePostVacationReject } from "../controllers/vacation/handlePostVacationReject.js";
import { handleDeleteVacation } from "../controllers/vacation/handleDeleteVacation.js";
import { handleBulkApproveVacation } from "../controllers/vacation/handleBulkApproveVacation.js";
import { handleBulkRejectVacation } from "../controllers/vacation/handleBulkRejectVacation.js";

export const vacationRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/vacation:
   *   get:
   *     tags:
   *       - Vacations
   *     summary: Retrieve vacations for the authenticated user
   *     description: |
   *       Returns vacation records for the authenticated user for a given year and month.
   *       Each row includes a denormalized `user` summary used by the calendar UI.
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
   */
  app.get("/", tryCatch(handleGetVacations));

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
   *         from:
   *           type: string
   *           format: date
   *         to:
   *           type: string
   *           format: date
   *         vacationType:
   *           type: string
   *         startTime:
   *           type: string
   *           nullable: true
   *         endTime:
   *           type: string
   *           nullable: true
   *         note:
   *           type: string
   *           nullable: true
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
   *     responses:
   *       '200':
   *         description: Vacation approved
   */
  app.post("/approve/:id", tryCatch(handlePostVacationApproval));

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
   */
  app.post(
    "/reject/:id",
    bodyValidationMiddleware(validateRejectVacation),
    tryCatch(handlePostVacationReject)
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
   * /api/vacation/{id}:
   *   delete:
   *     tags:
   *       - Vacations
   *     summary: Cancel (soft delete) a vacation request
   *     description: |
   *       Soft deletes the vacation row by setting `deletedAt`. The caller must own
   *       the row or have admin access on the parent group.
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
   *         description: Vacation cancelled
   *       '403':
   *         description: Not allowed
   *       '404':
   *         description: Vacation not found
   */
  app.delete("/:id", tryCatch(handleDeleteVacation));

  return app;
};
