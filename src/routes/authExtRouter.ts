import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  handleSignUpWithTeam,
  validateSignUpWithTeam,
} from "../controllers/auth/handleSignUpWithTeam.js";

/**
 * Routes that extend better-auth's `/api/auth/*` namespace with project-specific
 * orchestration endpoints. Mounted under `/api/auth` AFTER better-auth so the
 * core paths take precedence.
 */
export const authExtRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/auth/sign-up-with-team:
   *   post:
   *     tags:
   *       - Auth
   *     summary: Provision a user, optionally with their first group
   *     description: |
   *       `teamName` is optional. When omitted the account is created with no
   *       group and `group` comes back `null`; the user can then create a group
   *       or redeem an invite code. Booking time off requires a group.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - name
   *               - email
   *               - password
   *             properties:
   *               name:
   *                 type: string
   *               email:
   *                 type: string
   *               password:
   *                 type: string
   *               teamName:
   *                 type: string
   *                 description: Creates and joins a group when present.
   *     responses:
   *       '201':
   *         description: User created; `group` is null when no teamName was sent
   */
  app.post(
    "/sign-up-with-team",
    bodyValidationMiddleware(validateSignUpWithTeam),
    tryCatch(handleSignUpWithTeam)
  );

  return app;
};
