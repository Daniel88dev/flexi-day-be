import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import AppError from "../../utils/appError.js";
import { currentYear } from "../../utils/dateFunc.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertCanAddMember } from "../billing/guards.js";
import { claimEmployment, type Claim } from "../employment/claimEmployment.js";
import { getGroup } from "../group/groupServices.js";
import { lockOrganization } from "../organization/organizationServices.js";
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

export type Redemption = {
  /** Null for a directory invite that names no group. */
  membership: GroupUser | null;
  /** The Employment the account was bound to, when the redemption claimed one. */
  claim: Claim | null;
};

const organizationOf = async (invite: InviteLink, tx: DbTransaction): Promise<string> => {
  if (invite.groupId !== null) {
    const group = await getGroup(invite.groupId, tx);
    if (group) return group.organizationId;
  } else if (invite.employmentId !== null) {
    const [row] = await tx
      .select({ organizationId: employments.organizationId })
      .from(employments)
      .where(eq(employments.id, invite.employmentId))
      .limit(1);
    if (row) return row.organizationId;
  }
  throw new AppError({
    message: "This invite is revoked",
    logging: true,
    code: 410,
    context: { inviteId: invite.id },
    publicContext: { code: "INVITE_REVOKED" },
  });
};

/**
 * What redeeming an open invite does, whichever way it arrived — by code, by
 * link or by sign-up: first the Claim, binding the account to the open
 * account-less Employment the invite targets or whose address it was issued
 * to; then, when the invite names a group, the membership with the default
 * flags, the seat-cap check and this year's quota; and the single use. The
 * Claim runs before `createGroupUser`, whose `syncEmployment` would otherwise
 * refuse the clash with the account-less record. Callers have already decided
 * the invite is open and that this user may redeem it.
 */
export const redeemInvite = async (
  invite: InviteLink,
  userId: string,
  tx: DbTransaction,
  logContext: Record<string, unknown>
): Promise<Redemption> => {
  const organizationId = await organizationOf(invite, tx);

  if (invite.groupId !== null && (await getGroupUser(userId, invite.groupId, tx))) {
    throw new AppError({
      message: "You are already a member of this group",
      logging: true,
      code: 409,
      context: { ...logContext, userId, groupId: invite.groupId },
      publicContext: { code: "ALREADY_MEMBER", groupId: invite.groupId },
    });
  }

  await lockOrganization(organizationId, tx);
  // An invite with no address predates email invites and proves nothing about
  // whose record it is, so it never claims.
  const claim = invite.email
    ? await claimEmployment(
        {
          organizationId,
          userId,
          email: invite.email,
          targetEmploymentId: invite.employmentId,
        },
        tx
      )
    : null;

  const membership =
    invite.groupId === null
      ? null
      : await joinGroup(invite, invite.groupId, userId, tx, logContext);

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

  return { membership, claim };
};

const joinGroup = async (
  invite: InviteLink,
  groupId: string,
  userId: string,
  tx: DbTransaction,
  logContext: Record<string, unknown>
): Promise<GroupUser> => {
  // The authoritative member-cap gate: runs inside the single-use redemption
  // transaction, where the invite being redeemed still counts as open.
  await assertCanAddMember(groupId, tx, { redeemingOpenInvite: true });

  const membership = await createGroupUser(
    {
      id: generateRandomUUID(),
      userId,
      groupId,
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
      context: { ...logContext, userId, groupId, inviteId: invite.id },
    });
  }

  // MUST take `tx`: checking out a second pool connection while this
  // transaction holds one deadlocks the pool at concurrency >= pool size.
  const group = await getGroup(groupId, tx);
  await openQuotaFromGroupDefaults(
    {
      id: generateRandomUUID(),
      userId,
      groupId,
      relatedYear: currentYear().toString(),
      vacationDays: group?.defaultVacationDays ?? 0,
      homeOfficeDays: group?.defaultHomeOfficeDays ?? 0,
      sickDays: group?.defaultSickDays ?? 0,
    },
    tx
  );

  return membership;
};

/** The redemption as the three join routes answer it: the membership as before, plus the Claim. */
export const redemptionBody = ({ membership, claim }: Redemption) => ({
  ...(membership ?? { groupId: null }),
  claimed: claim,
});
