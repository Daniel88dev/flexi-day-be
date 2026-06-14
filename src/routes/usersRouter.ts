import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetMyApprovals } from "../controllers/users/handleGetMyApprovals.js";
import { handleGetMyDashboardSummary } from "../controllers/users/handleGetMyDashboardSummary.js";
import { handleGetMyBalances } from "../controllers/users/handleGetMyBalances.js";

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

  return app;
};
