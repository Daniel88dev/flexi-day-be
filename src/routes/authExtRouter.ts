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
   *     summary: Provision a user and their first group in one call
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
   *               - teamName
   *             properties:
   *               name:
   *                 type: string
   *               email:
   *                 type: string
   *               password:
   *                 type: string
   *               teamName:
   *                 type: string
   *     responses:
   *       '201':
   *         description: User + group created
   */
  app.post(
    "/sign-up-with-team",
    bodyValidationMiddleware(validateSignUpWithTeam),
    tryCatch(handleSignUpWithTeam)
  );

  return app;
};
