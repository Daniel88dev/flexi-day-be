import { Router } from "express";
import { handlePostGroup } from "../controllers/group/handlePostGroup.js";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetGroups } from "../controllers/group/handleGetGroups.js";
import { handlePutGroupQuotas } from "../controllers/group/handlePutGroupQuotas.js";
import { handlePutGroupWorkingDays } from "../controllers/group/handlePutGroupWorkingDays.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutGroupQuotas, validatePutGroupWorkingDays } from "../services/group/types.js";

export const groupRouter = (): Router => {
  const app = Router();

  app.post("/", tryCatch(handlePostGroup));

  app.get("/", tryCatch(handleGetGroups));

  /**
   * @openapi
   * /api/group/{groupId}/quotas:
   *   put:
   *     tags:
   *       - Groups
   *     summary: Update the group's default allowances
   *     description: |
   *       Sets the vacation / home-office days new members start from. Existing
   *       per-year quotas are not touched. Requires admin access on the group.
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
   *               - defaultVacationDays
   *               - defaultHomeOfficeDays
   *             properties:
   *               defaultVacationDays:
   *                 type: integer
   *               defaultHomeOfficeDays:
   *                 type: integer
   *     responses:
   *       '200':
   *         description: The updated group
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Group not found
   */
  app.put(
    "/:groupId/quotas",
    bodyValidationMiddleware(validatePutGroupQuotas),
    tryCatch(handlePutGroupQuotas)
  );

  /**
   * @openapi
   * /api/group/{groupId}/working-days:
   *   put:
   *     tags:
   *       - Groups
   *     summary: Set the group's working days
   *     description: |
   *       Sets which weekdays the group treats as working days. Vacation
   *       requests are only booked — and only counted against quotas — on these
   *       days. Days are `Date.getUTCDay()` numbers (0=Sunday … 6=Saturday); at
   *       least one is required. Requires admin access on the group.
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
   *               - workingDays
   *             properties:
   *               workingDays:
   *                 type: array
   *                 minItems: 1
   *                 maxItems: 7
   *                 items:
   *                   type: integer
   *                   minimum: 0
   *                   maximum: 6
   *     responses:
   *       '200':
   *         description: The updated group
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Group not found
   */
  app.put(
    "/:groupId/working-days",
    bodyValidationMiddleware(validatePutGroupWorkingDays),
    tryCatch(handlePutGroupWorkingDays)
  );

  return app;
};
