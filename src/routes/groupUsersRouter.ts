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
import { handleDeleteGroupUser } from "../controllers/groupUser/handleDeleteGroupUser.js";

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
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
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
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Group not found
   *       '409':
   *         description: That person already belongs to the group
   */
  /**
   * @openapi
   * /api/group-user/{groupId}/{userId}:
   *   delete:
   *     tags:
   *       - Group members
   *     summary: Remove a member from a group
   *     description: |
   *       Soft-deletes the membership. Requires group admin access, or admin of the group's organization. The
   *       group's manager cannot be removed; there is no manager-transfer route
   *       yet, so a manager can only leave by deleting the group. If the
   *       removed member was the main approver, approvals fall back to the
   *       manager; a temp approver slot is cleared. Deliberately available on
   *       read-only (over plan limit) groups, since removing members is how an
   *       owner gets back under their plan's limits.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: userId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The removed membership
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Group not found, or user is not a member
   *       '409':
   *         description: Target is the group manager, or already removed
   */
  app.delete("/:groupId/:userId", tryCatch(handleDeleteGroupUser));

  app.get("/:groupId/invites", tryCatch(handleGetGroupInvites));
  app.post(
    "/:groupId/invites",
    bodyValidationMiddleware(validatePostGroupInvite),
    tryCatch(handlePostGroupInvite)
  );

  /**
   * @openapi
   * /api/group-user:
   *   put:
   *     tags:
   *       - Group members
   *     summary: Update members' permissions in a group
   *     description: |
   *       Sets the four membership flags for one or more members at once.
   *       Requires group admin access, or admin of the group's organization. The flags are independent:
   *       `adminAccess` manages the group (members, quotas, invites, working
   *       days, mirroring) but does not decide on leave, and `approverAccess`
   *       decides on leave but manages nothing. `controlledUser` marks a member
   *       whose time off is tracked; `viewAccess` lets them see the group's
   *       records.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - groupId
   *               - data
   *             properties:
   *               groupId:
   *                 type: string
   *                 format: uuid
   *               data:
   *                 type: array
   *                 items:
   *                   type: object
   *                   required:
   *                     - userId
   *                     - viewAccess
   *                     - adminAccess
   *                     - approverAccess
   *                     - controlledUser
   *                   properties:
   *                     userId:
   *                       type: string
   *                     viewAccess:
   *                       type: boolean
   *                     adminAccess:
   *                       type: boolean
   *                     approverAccess:
   *                       type: boolean
   *                     controlledUser:
   *                       type: boolean
   *     responses:
   *       '200':
   *         description: Permissions updated
   *       '400':
   *         description: A named member does not belong to the group
   *       '403':
   *         description: |
   *           No permission for related group; or the caller tried to raise
   *           their own permissions; or a caller acting on organization
   *           authority tried to grant `approverAccess` — that role is only
   *           ever granted from inside the group.
   */
  app.put(
    "/",
    bodyValidationMiddleware(validatePutGroupUserUpdate),
    tryCatch(handleUpdateGroupUsers)
  );

  return app;
};
