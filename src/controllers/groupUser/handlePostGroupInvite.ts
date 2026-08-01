import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { assertGroupAdmin } from "./utils.js";
import type { ValidatedPostGroupInviteType } from "../../services/groupUser/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { generateInviteCode } from "../../utils/inviteCode.js";
import { db } from "../../db/db.js";
import { inviteExpiryFrom, notifyGroupInvited } from "../../services/groupUser/inviteNotifier.js";

const services = createDBServices();

/**
 * Issues a single-use invite code for a group and emails it to the invited
 * address. The code is bound to that address — see `handlePostGroupUser` — so
 * a forwarded email does not let a third party into the group.
 */
export const handlePostGroupInvite = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostGroupInviteType = req.body;

  await assertGroupAdmin(auth.userId, groupId);

  const group = await services.group.getGroup(groupId);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { url: req.url, userId: auth.userId, groupId },
    });
  }

  const existingUser = await services.user.getUserByEmail(data.email);
  if (existingUser) {
    const membership = await services.groupUser.getGroupUser(existingUser.id, groupId);
    if (membership) {
      throw new AppError({
        message: "That person is already a member of this group",
        logging: true,
        code: 409,
        context: { url: req.url, userId: auth.userId, groupId, email: data.email },
        publicContext: { email: data.email },
      });
    }
  }

  const invite = await db.transaction(async (tx) => {
    // Supersede any open invite for this address so only the newest code works
    // — and so the partial unique index does not reject the insert.
    await services.inviteLinks.revokeOpenInviteForEmail(groupId, data.email, tx);

    const created = await services.inviteLinks.createInviteLink(
      {
        id: generateRandomUUID(),
        groupId,
        code: generateInviteCode(),
        email: data.email,
        invitedByUserId: auth.userId,
        expiresAt: inviteExpiryFrom(new Date()),
      },
      tx
    );

    if (!created) {
      throw new AppError({
        message: "Failed to create invite",
        logging: true,
        code: 500,
        context: { url: req.url, userId: auth.userId, groupId, email: data.email },
      });
    }

    return created;
  });

  // Committed already: the admin gets the code back either way, so a mail
  // failure downgrades to "share it yourself" rather than failing the request.
  const emailDelivered = await notifyGroupInvited({
    email: data.email,
    groupName: group.groupName,
    inviterName: auth.userName,
    code: invite.code,
  });

  return res.status(201).json({ invite, emailDelivered });
};
