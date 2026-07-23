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
   *         description: Balance buckets per vacation type
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
   *       (`emailNotifications: true`).
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Preference flags
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 emailNotifications:
   *                   type: boolean
   *   put:
   *     tags:
   *       - Users
   *     summary: Update the caller's preferences
   *     description: |
   *       Turning `emailNotifications` off suppresses workflow mail (approval
   *       requests, decisions, cancellations). Account mail such as email
   *       confirmation is unaffected.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - emailNotifications
   *             properties:
   *               emailNotifications:
   *                 type: boolean
   *     responses:
   *       '200':
   *         description: The stored preferences
   */
  app.get("/me/settings", tryCatch(handleGetMySettings));
  app.put(
    "/me/settings",
    bodyValidationMiddleware(validatePutUserSettings),
    tryCatch(handlePutMySettings)
  );

  return app;
};
