import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  handleSignUpWithTeam,
  validateSignUpWithTeam,
} from "../controllers/auth/handleSignUpWithTeam.js";
import { authSession } from "../middleware/authSession.js";
import { validateInviteLinkToken } from "../services/groupUser/types.js";
import { handlePostInvitePreview } from "../controllers/groupUser/handlePostInvitePreview.js";
import { handlePostInviteJoin } from "../controllers/groupUser/handlePostInviteJoin.js";

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

  /**
   * @openapi
   * /api/auth/invite/preview:
   *   post:
   *     tags:
   *       - Auth
   *     summary: Describe an invite from its link secret
   *     description: |
   *       Public, no session. Answers for any invite the secret belongs to,
   *       whatever its state, and never consumes it. The secret travels in the
   *       body rather than the URL so it stays out of access logs. Behind the
   *       failures-only credential limiter, so probing for secrets runs out of
   *       budget.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - token
   *             properties:
   *               token:
   *                 type: string
   *                 description: The `token` query parameter of the invite link.
   *     responses:
   *       '200':
   *         description: The invite
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 groupId:
   *                   type: string
   *                   format: uuid
   *                 groupName:
   *                   type: string
   *                 inviterName:
   *                   type: string
   *                   nullable: true
   *                 invitedEmail:
   *                   type: string
   *                   format: email
   *                 status:
   *                   type: string
   *                   enum: [open, used, expired, revoked]
   *                 expiresAt:
   *                   type: string
   *                   format: date-time
   *       '404':
   *         description: No invite has this secret. `errors[0].context.code` is `INVITE_NOT_FOUND`.
   *       '422':
   *         description: Missing or malformed token
   *       '429':
   *         description: Too many failed attempts from this address
   */
  app.post(
    "/invite/preview",
    bodyValidationMiddleware(validateInviteLinkToken),
    tryCatch(handlePostInvitePreview)
  );

  /**
   * @openapi
   * /api/auth/invite/join:
   *   post:
   *     tags:
   *       - Auth
   *     summary: Join a group through the invite link
   *     description: |
   *       Redeems the invite for the signed-in user, whose address must be the
   *       invited one. Following the link proves the mailbox, so an unverified
   *       address is verified in the same transaction as the join. Otherwise
   *       identical to redeeming the invite code: same membership defaults,
   *       seat cap and quota, and either path uses up the invite.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - token
   *             properties:
   *               token:
   *                 type: string
   *                 description: The `token` query parameter of the invite link.
   *     responses:
   *       '201':
   *         description: The created membership
   *       '401':
   *         description: No session
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: >-
   *           The invite was issued for a different address.
   *           `errors[0].context.code` is `INVITE_EMAIL_MISMATCH`.
   *       '404':
   *         description: No invite has this secret. `errors[0].context.code` is `INVITE_NOT_FOUND`.
   *       '409':
   *         description: >-
   *           Already a member (`errors[0].context.code` is `ALREADY_MEMBER`,
   *           with `groupId`), or a concurrent redemption used the invite first.
   *       '410':
   *         description: >-
   *           The invite can no longer be redeemed. `errors[0].context.code` is
   *           `INVITE_USED`, `INVITE_EXPIRED` or `INVITE_REVOKED`.
   *       '422':
   *         description: Missing or malformed token
   *       '429':
   *         description: Too many failed attempts from this address
   */
  app.post(
    "/invite/join",
    authSession,
    bodyValidationMiddleware(validateInviteLinkToken),
    tryCatch(handlePostInviteJoin)
  );

  return app;
};
