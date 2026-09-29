import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetUserQuota } from "../controllers/quotas/handleGetUserQuota.js";
import { handlePutUserQuota } from "../controllers/quotas/handlePutUserQuota.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutUserQuota } from "../services/userYearQuotas/types.js";
import { handleGetCarryOverSuggestion } from "../controllers/quotas/handleGetCarryOverSuggestion.js";

export const quotasRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/quotas/{groupId}:
   *   get:
   *     tags:
   *       - Quotas
   *     summary: Read the group's allowances for a year
   *     description: |
   *       Returns the `user_year_quotas` rows of the group for one year, every
   *       member's unless `userId` narrows it. The caller needs View or Admin on
   *       their membership, to be the group's manager, or to be an admin of the
   *       group's organization; Admin implies View here as on every other group
   *       read.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: year
   *         in: query
   *         required: false
   *         description: Defaults to the current year.
   *         schema:
   *           type: integer
   *           minimum: 2023
   *           maximum: 2050
   *       - name: userId
   *         in: query
   *         required: false
   *         description: |
   *           Only this member's row. Currently validated as a UUID, so a
   *           better-auth user id is rejected with 400.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The quota rows, possibly empty
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   id:
   *                     type: string
   *                   userId:
   *                     type: string
   *                   groupId:
   *                     type: string
   *                     format: uuid
   *                   relatedYear:
   *                     type: string
   *                     example: "2026"
   *                   vacationDays:
   *                     type: integer
   *                   homeOfficeDays:
   *                     type: integer
   *                   sickDays:
   *                     type: integer
   *                   carriedOverDays:
   *                     type: integer
   *                   createdAt:
   *                     type: string
   *                     format: date-time
   *                   updatedAt:
   *                     type: string
   *                     format: date-time
   *       '400':
   *         description: Invalid `year` or `userId`
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: >-
   *           The caller has neither View nor Admin in the group, does not
   *           manage it and does not administer its organization. Body:
   *           `{ "errors": [{ "message": "No permission for related group" }] }`.
   *       '422':
   *         description: Malformed groupId
   */
  app.get("/:groupId", tryCatch(handleGetUserQuota));

  /**
   * @openapi
   * /api/quotas/{groupId}/carryover-suggestion:
   *   get:
   *     tags:
   *       - Quotas
   *     summary: Suggested carry-over from the previous year
   *     description: |
   *       Returns the member's unused vacation allowance from `year - 1` so the
   *       quota dialog can pre-fill this year's carry-over. Pending days count
   *       as spent. Advisory only — the stored value is whatever the admin
   *       submits to `PUT /api/quotas/{groupId}`. Requires admin access.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: userId
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *       - name: year
   *         in: query
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       '200':
   *         description: Suggestion with the figures it was derived from
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 previousYear:
   *                   type: integer
   *                 allocated:
   *                   type: number
   *                 used:
   *                   type: number
   *                 suggestion:
   *                   type: integer
   *       '403':
   *         description: No permission for related group
   */
  app.get("/:groupId/carryover-suggestion", tryCatch(handleGetCarryOverSuggestion));

  /**
   * @openapi
   * /api/quotas/{groupId}:
   *   put:
   *     tags:
   *       - Quotas
   *     summary: Set a member's allowance for a year
   *     description: |
   *       Creates or replaces the member's `user_year_quotas` row for the given
   *       year. Requires group admin access, being the group's manager, or admin of the group's organization; the change is recorded in
   *       the `changes` audit log.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
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
   *               - userId
   *               - year
   *               - vacationDays
   *               - homeOfficeDays
   *             properties:
   *               userId:
   *                 type: string
   *               year:
   *                 type: integer
   *               vacationDays:
   *                 type: integer
   *               homeOfficeDays:
   *                 type: integer
   *               sickDays:
   *                 type: integer
   *                 description: |
   *                   Sick day benefit allowance. Metered only while the
   *                   organization has the benefit enabled on a paid plan;
   *                   never carried over between years. Omitting the field
   *                   leaves the member's stored value unchanged.
   *               carriedOverDays:
   *                 type: integer
   *                 description: |
   *                   Unused vacation days rolled forward from the previous
   *                   year. Omitting the field leaves the member's stored
   *                   value unchanged.
   *     responses:
   *       '200':
   *         description: The stored quota row
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: User is not a member of this group
   */
  app.put(
    "/:groupId",
    bodyValidationMiddleware(validatePutUserQuota),
    tryCatch(handlePutUserQuota)
  );

  return app;
};
