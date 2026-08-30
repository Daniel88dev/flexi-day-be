import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetUserQuota } from "../controllers/quotas/handleGetUserQuota.js";
import { handlePutUserQuota } from "../controllers/quotas/handlePutUserQuota.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutUserQuota } from "../services/userYearQuotas/types.js";
import { handleGetCarryOverSuggestion } from "../controllers/quotas/handleGetCarryOverSuggestion.js";

export const quotasRouter = (): Router => {
  const app = Router();

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
   *                 format: uuid
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
