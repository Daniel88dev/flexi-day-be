import type { DbTransaction } from "../../db/db.js";
import AppError from "../../utils/appError.js";
import { currentYear } from "../../utils/dateFunc.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertCanAddMember } from "../billing/guards.js";
import { getGroup } from "../group/groupServices.js";
import { openQuotaFromGroupDefaults } from "../userYearQuotas/userYearQuotasServices.js";
import { createGroupUser, getGroupUser } from "./groupUserServices.js";
import { inviteStatus, useInviteLink } from "./inviteLinkServices.js";
import type { GroupUser, InviteLink } from "./types.js";

/**
 * The checks every invite link redemption makes before anything is written: a
 * known secret, an open invite, and the invited address. `email` must already
 * be lower-cased.
 */
export const assertOpenInviteFor = (
  invite: InviteLink | undefined,
  email: string,
  logContext: Record<string, unknown>
): InviteLink => {
  if (!invite?.email) {
    throw new AppError({
      message: "Invite not found",
      logging: true,
      code: 404,
      context: logContext,
      publicContext: { code: "INVITE_NOT_FOUND" },
    });
  }

  const status = inviteStatus(invite);
  if (status !== "open") {
    throw new AppError({
      message: `This invite is ${status}`,
      logging: true,
      code: 410,
      context: { ...logContext, inviteId: invite.id },
      publicContext: { code: `INVITE_${status.toUpperCase()}` },
    });
  }

  if (invite.email !== email) {
    throw new AppError({
      message: "This invite was issued for a different email address",
      logging: true,
      code: 403,
      context: { ...logContext, inviteId: invite.id },
      publicContext: { code: "INVITE_EMAIL_MISMATCH" },
    });
  }

  return invite;
};

/**
 * What redeeming an open invite does, whichever way it arrived — by code or by
 * link: the membership with the default flags, the seat-cap check, this year's
 * quota and the single use. Callers have already decided the invite is open and
 * that this user may redeem it.
 */
export const redeemInvite = async (
  invite: InviteLink,
  userId: string,
  tx: DbTransaction,
  logContext: Record<string, unknown>
): Promise<GroupUser> => {
  const existingMembership = await getGroupUser(userId, invite.groupId, tx);

  if (existingMembership) {
    throw new AppError({
      message: "You are already a member of this group",
      logging: true,
      code: 409,
      context: { ...logContext, userId, groupId: invite.groupId },
      publicContext: { code: "ALREADY_MEMBER", groupId: invite.groupId },
    });
  }

  // The authoritative member-cap gate: runs inside the single-use redemption
  // transaction, where the invite being redeemed still counts as open.
  await assertCanAddMember(invite.groupId, tx, { redeemingOpenInvite: true });

  const membership = await createGroupUser(
    {
      id: generateRandomUUID(),
      userId,
      groupId: invite.groupId,
      viewAccess: true,
      adminAccess: false,
      approverAccess: false,
      controlledUser: true,
    },
    tx
  );

  if (!membership) {
    throw new AppError({
      message: "Failed to create group user",
      logging: true,
      code: 500,
      context: { ...logContext, userId, groupId: invite.groupId, inviteId: invite.id },
    });
  }

  // MUST take `tx`: checking out a second pool connection while this
  // transaction holds one deadlocks the pool at concurrency >= pool size.
  const group = await getGroup(invite.groupId, tx);
  await openQuotaFromGroupDefaults(
    {
      id: generateRandomUUID(),
      userId,
      groupId: invite.groupId,
      relatedYear: currentYear().toString(),
      vacationDays: group?.defaultVacationDays ?? 0,
      homeOfficeDays: group?.defaultHomeOfficeDays ?? 0,
      sickDays: group?.defaultSickDays ?? 0,
    },
    tx
  );

  // `usedAt IS NULL` in the update is what makes the invite single-use: a
  // concurrent second redemption matches no row and rolls this back.
  const used = await useInviteLink(invite.code, tx);

  if (!used) {
    throw new AppError({
      message: "Failed to update invite link",
      logging: true,
      code: 409,
      context: { ...logContext, userId, groupId: invite.groupId, inviteId: invite.id },
    });
  }

  return membership;
};
