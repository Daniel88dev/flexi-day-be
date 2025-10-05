import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetVacations } from "../controllers/vacation/handleGetVacations.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePostVacation } from "../services/vacation/types.js";
import { handlePostVacation } from "../controllers/vacation/handlePostVacation.js";
import { handlePostVacationApproval } from "../controllers/vacation/handlePostVacationApproval.js";

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
   *       The endpoint uses the authenticated session derived from the request.
   *     operationId: handleGetVacations
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: year
   *         in: query
   *         description: Four-digit year to filter vacations (defaults to current year)
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 2023
   *           maximum: 2050
   *           example: 2025
   *       - name: month
   *         in: query
   *         description: Month number (1-12) to filter vacations (defaults to current month)
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 12
   *           example: 12
   *     responses:
   *       '200':
   *         description: Array of vacations matching the query
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Vacation'
   *       '401':
   *         description: Unauthorized - missing or invalid authentication
   *       '422':
   *         description: Unprocessable Entity - invalid query parameters (validation error)
   *       '500':
   *         description: Internal Server Error
   * components:
   *   securitySchemes:
   *     bearerAuth:
   *       type: http
   *       scheme: bearer
   *       bearerFormat: JWT
   */
  app.get("/", tryCatch(handleGetVacations));

  /**
   * @openapi
   * /api/vacation/create-vacation:
   *   post:
   *     tags:
   *       - Vacations
   *     summary: Create a new vacation request
   *     description: |
   *       Creates a vacation record for the authenticated user within the specified group.
   *       The request body must include a valid UUID for `groupId` and a date for `requestedDay`.
   *       The authenticated user must have access to the group (controlledUser) to create the record.
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
   *         description: Vacation created successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Vacation'
   *       '401':
   *         description: Unauthorized - missing or invalid authentication
   *       '403':
   *         description: Forbidden - no access for related group
   *       '422':
   *         description: Unprocessable Entity - validation error for request body
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *                   example: Invalid data
   *                 details:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       message:
   *                         type: string
   *       '500':
   *         description: Internal Server Error - failed to create vacation
   * components:
   *   securitySchemes:
   *     bearerAuth:
   *       type: http
   *       scheme: bearer
   *       bearerFormat: JWT
   *   schemas:
   *     PostVacation:
   *       type: object
   *       required:
   *         - groupId
   *         - requestedDay
   *       properties:
   *         groupId:
   *           type: string
   *           format: uuid
   *           description: UUID of the group where the vacation is requested.
   *           example: "3fa85f64-5717-4562-b3fc-2c963f66afa6"
   *         requestedDay:
   *           type: string
   *           format: date
   *           description: The date requested for vacation (ISO date).
   *           example: "2025-12-24"
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
   *     description: |
   *       Approves a pending vacation request identified by its UUID.
   *       Only users who are listed as approvers for the vacation's group (main or temp approver)
   *       may approve the request. The endpoint requires authentication.
   *     operationId: handlePostVacationApproval
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         description: UUID of the vacation to approve
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *           example: "3fa85f64-5717-4562-b3fc-2c963f66afa6"
   *     responses:
   *       '200':
   *         description: Vacation approved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Vacation approved"
   *       '401':
   *         description: Unauthorized - missing or invalid authentication
   *       '403':
   *         description: Forbidden - the authenticated user is not allowed to approve this vacation
   *       '404':
   *         description: Not Found - vacation with given id does not exist
   *       '422':
   *         description: Unprocessable Entity - invalid id format (UUID validation)
   *       '500':
   *         description: Internal Server Error
   * components:
   *   securitySchemes:
   *     bearerAuth:
   *       type: http
   *       scheme: bearer
   *       bearerFormat: JWT
   */
  app.post("/approve/:id", tryCatch(handlePostVacationApproval));

  return app;
};
