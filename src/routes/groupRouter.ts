import { Router } from "express";
import { handlePostGroup } from "../controllers/group/handlePostGroup.js";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetGroups } from "../controllers/group/handleGetGroups.js";
import { handlePutGroupQuotas } from "../controllers/group/handlePutGroupQuotas.js";
import { handlePutGroupWorkingDays } from "../controllers/group/handlePutGroupWorkingDays.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutGroupQuotas, validatePutGroupWorkingDays } from "../services/group/types.js";
import { validatePutGroupMirrors } from "../services/groupMirror/types.js";
import { handleGetGroupMirrors } from "../controllers/group/handleGetGroupMirrors.js";
import { handlePutGroupMirrors } from "../controllers/group/handlePutGroupMirrors.js";

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

  /**
   * @openapi
   * /api/group/{groupId}/mirrors:
   *   get:
   *     tags:
   *       - Groups
   *     summary: The caller's mirroring setup for this group
   *     description: |
   *       Lists every other group the caller belongs to and whether their
   *       records from it are currently shown inside this group. Mirroring is a
   *       per-user choice, so this only ever describes the caller.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: Candidate source groups with their mirrored state
   *       '403':
   *         description: Caller does not belong to the group
   *   put:
   *     tags:
   *       - Groups
   *     summary: Set which groups the caller mirrors into this one
   *     description: |
   *       Replaces the caller's mirror sources for this group. Mirrored records
   *       are shown here read-only: they are approved, counted against quotas
   *       and reported in their source group alone, and never need a decision
   *       in this one. The caller must belong to the target and to every source
   *       group; an empty array turns mirroring off.
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
   *               - sourceGroupIds
   *             properties:
   *               sourceGroupIds:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *     responses:
   *       '200':
   *         description: The caller's mirrors into this group after the update
   *       '403':
   *         description: Caller does not belong to the target or a source group
   *       '422':
   *         description: A group cannot mirror itself
   */
  app.get("/:groupId/mirrors", tryCatch(handleGetGroupMirrors));
  app.put(
    "/:groupId/mirrors",
    bodyValidationMiddleware(validatePutGroupMirrors),
    tryCatch(handlePutGroupMirrors)
  );

  return app;
};
