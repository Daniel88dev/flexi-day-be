import { Router } from "express";
import { handleGetGroupUsers } from "../controllers/groupUser/handleGetGroupUsers.js";
import { handlePostGroupUser } from "../controllers/groupUser/handlePostGroupUser.js";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { handleUpdateGroupUsers } from "../controllers/groupUser/handleUpdateGroupUsers.js";
import {
  validatePostGroupInvite,
  validatePutGroupUserUpdate,
} from "../services/groupUser/types.js";
import { handlePostGroupInvite } from "../controllers/groupUser/handlePostGroupInvite.js";
import { handleGetGroupInvites } from "../controllers/groupUser/handleGetGroupInvites.js";
import { handleDeleteGroupInvite } from "../controllers/groupUser/handleDeleteGroupInvite.js";

export const groupUsersRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/group-user/invites/{inviteId}:
   *   delete:
   *     tags:
   *       - Group members
   *     summary: Revoke an outstanding invite
   *     description: |
   *       Stops the invite's code from working. Requires admin access on the
   *       group the invite belongs to. Already used or already revoked invites
   *       return 409.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: inviteId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The revoked invite
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Invite not found
   *       '409':
   *         description: Invite already used or revoked
   */
  app.delete("/invites/:inviteId", tryCatch(handleDeleteGroupInvite));

  /**
   * @openapi
   * /api/group-user/code/{validationCode}:
   *   post:
   *     tags:
   *       - Group members
   *     summary: Join a group with an invite code
   *     description: |
   *       Redeems a single-use invite code for the signed-in user. Codes are
   *       accepted case-insensitively and with or without their dashes. An
   *       invite issued to an email address may only be redeemed by an account
   *       with that address.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: validationCode
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '201':
   *         description: The created membership
   *       '400':
   *         description: Malformed code
   *       '403':
   *         description: Invite was issued for a different email address
   *       '404':
   *         description: Invalid, revoked or expired code
   *       '409':
   *         description: Already a member, or the code was just redeemed
   */
  app.post("/code/:validationCode", tryCatch(handlePostGroupUser));

  app.get("/:groupId", tryCatch(handleGetGroupUsers));

  /**
   * @openapi
   * /api/group-user/{groupId}/invites:
   *   get:
   *     tags:
   *       - Group members
   *     summary: List the group's outstanding invites
   *     description: |
   *       Invites that can still be redeemed — not used, not revoked, not
   *       expired — newest first. Admin-only: the response carries the codes.
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
   *         description: Outstanding invites
   *       '403':
   *         description: No permission for related group
   *   post:
   *     tags:
   *       - Group members
   *     summary: Invite someone to the group by email
   *     description: |
   *       Issues a single-use code, emails it to the address with instructions,
   *       and returns it so the admin can also share it directly. Any earlier
   *       open invite for the same address is revoked. `emailDelivered` is
   *       false when the code was created but the mail could not be sent.
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
   *               - email
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *     responses:
   *       '201':
   *         description: The created invite plus whether the email went out
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Group not found
   *       '409':
   *         description: That person already belongs to the group
   */
  app.get("/:groupId/invites", tryCatch(handleGetGroupInvites));
  app.post(
    "/:groupId/invites",
    bodyValidationMiddleware(validatePostGroupInvite),
    tryCatch(handlePostGroupInvite)
  );

  app.put(
    "/",
    bodyValidationMiddleware(validatePutGroupUserUpdate),
    tryCatch(handleUpdateGroupUsers)
  );

  return app;
};
