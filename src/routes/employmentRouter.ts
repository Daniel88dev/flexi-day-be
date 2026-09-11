import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetEmployment } from "../controllers/employment/handleGetEmployment.js";
import { handleGetEmployments } from "../controllers/employment/handleGetEmployments.js";

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
   *           Array of `{ id, userId, email, startedAt, endedAt, ended, user }`,
   *           by name.
   *       '422':
   *         description: Missing or malformed organizationId
   *       '403':
   *         description: The caller administers nothing in this organization
   */
  app.get("/list", tryCatch(handleGetEmployments));

  return app;
};
