import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { assertGroupAdmin } from "../../services/groupUser/groupAccess.js";
import type { ValidatedPostGroupInviteType } from "../../services/groupUser/types.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { generateInviteCode } from "../../utils/inviteCode.js";
import { db } from "../../db/db.js";
import { inviteExpiryFrom, notifyGroupInvited } from "../../services/groupUser/inviteNotifier.js";
import { assertCanAddMember, assertGroupWritable } from "../../services/billing/guards.js";
import { lockOrganization } from "../../services/organization/organizationServices.js";
import { getGroup } from "../../services/group/groupServices.js";
import { getGroupUser } from "../../services/groupUser/groupUserServices.js";
import {
  createInviteLink,
  revokeOpenInviteForEmail,
} from "../../services/groupUser/inviteLinkServices.js";
import { getUserByEmail } from "../../services/user/userServices.js";

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

  // A read-only group must not grow; removing members is the way back under
  // the limit, not adding more.
  await assertGroupWritable(groupId);

  const group = await getGroup(groupId);
  if (!group) {
    throw new AppError({
      message: "Group not found",
      logging: true,
      code: 404,
      context: { url: req.url, userId: auth.userId, groupId },
    });
  }

  const existingUser = await getUserByEmail(data.email);
  if (existingUser) {
    const membership = await getGroupUser(existingUser.id, groupId);
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
    // Lock the organization FIRST, before touching invite_link. The redemption
    // path (handlePostGroupUser) locks organization → invite_link; taking them
    // in the opposite order here would deadlock a resend against a concurrent
    // redemption of the code being replaced.
    await lockOrganization(group.organizationId, tx);

    // Supersede any open invite for this address so only the newest code works
    // — and so the partial unique index does not reject the insert. This runs
    // BEFORE the seat check: a re-invite reuses the seat its own outstanding
    // invite already reserves, and counting both would 402 a no-op change.
    await revokeOpenInviteForEmail(groupId, data.email, tx);

    // Inside the transaction, which row-locks the organization, so two admins
    // inviting at once cannot both pass a check made against the same
    // pre-insert seat count.
    await assertCanAddMember(groupId, tx);

    const created = await createInviteLink(
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
