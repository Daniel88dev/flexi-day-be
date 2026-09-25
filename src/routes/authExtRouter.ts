import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  handleSignUpWithTeam,
  validateSignUpWithTeam,
} from "../controllers/auth/handleSignUpWithTeam.js";
import { authSession } from "../middleware/authSession.js";
import { validateInviteLinkToken, validateInviteSignUp } from "../services/groupUser/types.js";
import { handlePostInvitePreview } from "../controllers/groupUser/handlePostInvitePreview.js";
import { handlePostInviteJoin } from "../controllers/groupUser/handlePostInviteJoin.js";
import { handlePostInviteSignUp } from "../controllers/groupUser/handlePostInviteSignUp.js";

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

  /**
   * @openapi
   * /api/auth/invite/sign-up:
   *   post:
   *     tags:
   *       - Auth
   *     summary: Create an account from the invite link and join the group
   *     description: |
   *       Public. For an invitee with no account. The address must be the
   *       invited one (any letter case). Runs better-auth's own email sign-up,
   *       so the password policy and the breached-password check are the same
   *       as a normal sign-up. Following the link proves the mailbox, so the
   *       account is verified in the same transaction as the join and no
   *       confirmation email is sent. The join itself is the same as the other
   *       redemption paths: same membership defaults, seat cap and quota, and
   *       it uses up the invite. On success the response signs the user in with
   *       the same session cookie as `POST /api/auth/sign-in/email`.
   *
   *       Every invite check runs before the account check, so only the holder
   *       of the secret learns whether the address already has an account.
   *       Behind the failures-only credential limiter.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - token
   *               - name
   *               - email
   *               - password
   *             properties:
   *               token:
   *                 type: string
   *                 minLength: 32
   *                 maxLength: 128
   *                 description: The `token` query parameter of the invite link.
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 120
   *               email:
   *                 type: string
   *                 format: email
   *                 description: Must be the invited address.
   *               password:
   *                 type: string
   *                 description: better-auth's password policy applies (8 to 128 characters, not breached).
   *     responses:
   *       '201':
   *         description: >-
   *           Account created, verified, joined and signed in. `Set-Cookie`
   *           carries the session. `user` and `token` are null in the rare case
   *           the account joined but the session could not be started; a normal
   *           sign-in then works.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user:
   *                   type: object
   *                   nullable: true
   *                 token:
   *                   type: string
   *                   nullable: true
   *                 membership:
   *                   type: object
   *                   description: The created membership
   *       '400':
   *         description: >-
   *           The password breaks the sign-up policy. `errors[0].context.code`
   *           is better-auth's code, e.g. `PASSWORD_TOO_SHORT`,
   *           `PASSWORD_TOO_LONG` or `PASSWORD_COMPROMISED`.
   *       '402':
   *         description: |
   *           Plan limit reached. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT", limit, current }`. No account is created.
   *       '403':
   *         description: >-
   *           The invite was issued for a different address.
   *           `errors[0].context.code` is `INVITE_EMAIL_MISMATCH`.
   *       '404':
   *         description: No invite has this secret. `errors[0].context.code` is `INVITE_NOT_FOUND`.
   *       '409':
   *         description: A concurrent redemption used the invite first. No account is left behind.
   *       '410':
   *         description: >-
   *           The invite can no longer be redeemed. `errors[0].context.code` is
   *           `INVITE_USED`, `INVITE_EXPIRED` or `INVITE_REVOKED`.
   *       '422':
   *         description: >-
   *           Missing or malformed fields, or the address already has an
   *           account (`errors[0].context.code` is
   *           `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`).
   *       '429':
   *         description: Too many failed attempts from this address
   */
  app.post(
    "/invite/sign-up",
    bodyValidationMiddleware(validateInviteSignUp),
    tryCatch(handlePostInviteSignUp)
  );

  return app;
};
