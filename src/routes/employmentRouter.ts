import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePatchEmployment } from "../services/employment/types.js";
import { handleGetEmployment } from "../controllers/employment/handleGetEmployment.js";
import { handleGetEmployments } from "../controllers/employment/handleGetEmployments.js";
import { handlePatchEmployment } from "../controllers/employment/handlePatchEmployment.js";

export const employmentRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/employment:
   *   get:
   *     tags:
   *       - Employment
   *     summary: One Employment in an organization
   *     description: |
   *       One person's membership in one organization — the subject of
   *       attendance, with the spell it currently runs for and the per-person
   *       override of the organization's required minutes per day (null unless
   *       one was set). Defaults to the caller; `userId` asks about someone
   *       else and needs standing over them — their own group's admin, or an
   *       admin of the organization. `organizationId` is required: an employee
   *       may belong to several organizations and administers none, so there is
   *       no default to fall back on.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: userId
   *         description: Defaults to the caller.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           `{ id, organizationId, userId, startedAt, endedAt, ended,
   *           requiredMinutesPerDay }`
   *       '403':
   *         description: |
   *           The caller has no standing over that person. Decided before the
   *           lookup, so it does not leak whether the Employment exists.
   *       '404':
   *         description: No Employment for that person in that organization
   *       '422':
   *         description: Missing or malformed organizationId
   */
  app.get("/", tryCatch(handleGetEmployment));

  /**
   * @openapi
   * /api/employment/list:
   *   get:
   *     tags:
   *       - Employment
   *     summary: An organization's Employments
   *     description: |
   *       The roster, scoped to what the caller may read: every Employment for
   *       an organization admin, the members of the groups they administer for
   *       a group admin. A group's manager holds no membership row, so their
   *       own Employment — and anyone else's who belongs to no group — appears
   *       only for organization admins, as do ended ones, which carry
   *       `ended: true`. A group admin's slice is their groups' current
   *       members — their own row is not in it, and is on `GET
   *       /api/employment`. Callers who administer nothing get 403.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           Array of `{ id, userId, email, startedAt, endedAt, ended,
   *           requiredMinutesPerDay, user }`, by name.
   *           `requiredMinutesPerDay` is this person's own required time, null
   *           while the organization's rule stands.
   *       '422':
   *         description: Missing or malformed organizationId
   *       '403':
   *         description: The caller administers nothing in this organization
   */
  app.get("/list", tryCatch(handleGetEmployments));

  /**
   * @openapi
   * /api/employment/{employmentId}:
   *   patch:
   *     tags:
   *       - Employment
   *     summary: Override one person's required minutes per day
   *     description: |
   *       Replaces the organization's required daily time for this one
   *       Employment — the part-timer who would otherwise read as short every
   *       day. `null` clears the override and puts them back on the
   *       organization's figure, which is why the field is nullable rather than
   *       optional: a body with nothing in it would otherwise be
   *       indistinguishable from one asking to clear it.
   *
   *       Organization admins only. A group admin reads their members'
   *       attendance but does not decide what a contract owes, so the read
   *       matrix does not apply here.
   *
   *       Nothing recomputes: the month view measures against whatever the row
   *       says when it is read, so a change moves past balances too.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - requiredMinutesPerDay
   *             properties:
   *               requiredMinutesPerDay:
   *                 type: integer
   *                 nullable: true
   *                 minimum: 0
   *                 maximum: 1440
   *     responses:
   *       '200':
   *         description: |
   *           `{ id, organizationId, userId, startedAt, endedAt, ended,
   *           requiredMinutesPerDay }`
   *       '403':
   *         description: The caller does not administer that organization
   *       '404':
   *         description: No such Employment
   *       '422':
   *         description: Missing or out-of-range requiredMinutesPerDay
   */
  app.patch(
    "/:employmentId",
    bodyValidationMiddleware(validatePatchEmployment),
    tryCatch(handlePatchEmployment)
  );

  return app;
};
