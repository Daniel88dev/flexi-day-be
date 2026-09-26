import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetMyApprovals } from "../controllers/users/handleGetMyApprovals.js";
import { handleGetMyDashboardSummary } from "../controllers/users/handleGetMyDashboardSummary.js";
import { handleGetMyBalances } from "../controllers/users/handleGetMyBalances.js";
import { handleGetMySettings } from "../controllers/users/handleGetMySettings.js";
import { handlePutMySettings } from "../controllers/users/handlePutMySettings.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePutUserSettings } from "../services/userSettings/types.js";

export const usersRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/users/me/approvals:
   *   get:
   *     tags:
   *       - Users
   *     summary: List pending vacations the caller can approve
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Array of pending approvals with contiguous days collapsed
   */
  app.get("/me/approvals", tryCatch(handleGetMyApprovals));

  /**
   * @openapi
   * /api/users/me/dashboard-summary:
   *   get:
   *     tags:
   *       - Users
   *     summary: Rolled-up dashboard counts for the caller
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Stat-card counts
   */
  app.get("/me/dashboard-summary", tryCatch(handleGetMyDashboardSummary));

  /**
   * @openapi
   * /api/users/me/balances:
   *   get:
   *     tags:
   *       - Users
   *     summary: Aggregated leave balances for the caller for a given year
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: year
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *     responses:
   *       '200':
   *         description: Balance buckets per calendar record type
   */
  app.get("/me/balances", tryCatch(handleGetMyBalances));

  /**
   * @openapi
   * /api/users/me/settings:
   *   get:
   *     tags:
   *       - Users
   *     summary: The caller's preferences
   *     description: |
   *       Users without a stored row are on the defaults
   *       (`emailNotifications: true`, `dashboardScope: MINE`,
   *       `dashboardGroupId: null`, `dashboardCalendarView: LANES`,
   *       `attendanceLocationNoticeDismissed: false`).
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Preference flags
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserSettings'
   *       '401':
   *         description: Not signed in
   *   put:
   *     tags:
   *       - Users
   *     summary: Update the caller's preferences
   *     description: |
   *       A partial update — the screen saves one card at a time, so any subset
   *       of the fields may be sent and the rest keep their stored value.
   *
   *       Turning `emailNotifications` off suppresses workflow mail (approval
   *       requests, decisions, cancellations). Account mail such as email
   *       confirmation is unaffected.
   *
   *       `dashboardScope: GROUP` makes the dashboard calendar show
   *       `dashboardGroupId`'s records instead of only the caller's own. That
   *       group must already be selected or supplied in the same request, and
   *       the caller must have view access on it. That check runs only when
   *       the request sends `dashboardScope` or `dashboardGroupId`, so saving
   *       any other field succeeds even if the stored group is no longer
   *       viewable.
   *
   *       `dashboardCalendarView` picks how the dashboard month calendar draws
   *       leave: `LANES` (one bar per person, the default) or `STRIPES`
   *       (compact stripes with a day list). Every client reads the same value.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             allOf:
   *               - $ref: '#/components/schemas/UserSettings'
   *             minProperties: 1
   *     responses:
   *       '200':
   *         description: The stored preferences
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserSettings'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: No access to view the selected group's records
   *       '422':
   *         description: |
   *           The body failed validation (no field supplied, or a value outside
   *           its enum, such as a `dashboardCalendarView` other than `LANES` or
   *           `STRIPES`), or group scope was requested without a group
   * components:
   *   schemas:
   *     UserSettings:
   *       type: object
   *       properties:
   *         emailNotifications:
   *           type: boolean
   *         dashboardScope:
   *           type: string
   *           enum: [MINE, GROUP]
   *         dashboardGroupId:
   *           type: string
   *           nullable: true
   *         dashboardCalendarView:
   *           type: string
   *           enum: [LANES, STRIPES]
   *           default: LANES
   *           description: How the dashboard month calendar draws leave.
   *         attendanceLocationNoticeDismissed:
   *           type: boolean
   *           description: |
   *             Whether the person has dismissed the clock's notice that the
   *             organization records location. The widget sets it and then
   *             never shows the notice again; an ordinary preference otherwise,
   *             so sending `false` brings the notice back for that person and
   *             nobody else.
   */
  app.get("/me/settings", tryCatch(handleGetMySettings));
  app.put(
    "/me/settings",
    bodyValidationMiddleware(validatePutUserSettings),
    tryCatch(handlePutMySettings)
  );

  return app;
};
