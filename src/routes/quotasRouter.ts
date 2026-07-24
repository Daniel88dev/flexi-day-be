import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetUserQuota } from "../controllers/quotas/handleGetUserQuota.js";
import { handlePutUserQuota } from "../controllers/quotas/handlePutUserQuota.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutUserQuota } from "../services/userYearQuotas/types.js";

export const quotasRouter = (): Router => {
  const app = Router();

  app.get("/:groupId", tryCatch(handleGetUserQuota));

  /**
   * @openapi
   * /api/quotas/{groupId}:
   *   put:
   *     tags:
   *       - Quotas
   *     summary: Set a member's allowance for a year
   *     description: |
   *       Creates or replaces the member's `user_year_quotas` row for the given
   *       year. Requires admin access on the group; the change is recorded in
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
   *     responses:
   *       '200':
   *         description: The stored quota row
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
