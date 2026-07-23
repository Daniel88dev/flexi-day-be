import { Router } from "express";
import { handlePostGroup } from "../controllers/group/handlePostGroup.js";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetGroups } from "../controllers/group/handleGetGroups.js";
import { handlePutGroupQuotas } from "../controllers/group/handlePutGroupQuotas.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutGroupQuotas } from "../services/group/types.js";

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

  return app;
};
