import { db, type DbTransaction } from "../../db/db.js";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  InviteLink,
  InviteLinkInsertType,
  InviteLinkListItem,
  InvitePreview,
  InviteStatus,
} from "./types.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";

// Every column but `linkSecretHash`, which no reader outside the link lookup
// has any use for and no response may carry.
const inviteColumns = {
  id: inviteLink.id,
  groupId: inviteLink.groupId,
  code: inviteLink.code,
  email: inviteLink.email,
  invitedByUserId: inviteLink.invitedByUserId,
  usedAt: inviteLink.usedAt,
  revokedAt: inviteLink.revokedAt,
  expiresAt: inviteLink.expiresAt,
  createdAt: inviteLink.createdAt,
  updatedAt: inviteLink.updatedAt,
};

export const inviteStatus = (
  invite: Pick<InviteLink, "usedAt" | "revokedAt" | "expiresAt">
): InviteStatus => {
  if (invite.usedAt) return "used";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt <= new Date()) return "expired";
  return "open";
};

export const createInviteLink = async (
  data: InviteLinkInsertType,
  tx?: DbTransaction
): Promise<InviteLink | undefined> => {
  const [row] = await (tx ?? db).insert(inviteLink).values(data).returning(inviteColumns);

  return row;
};

export const getInviteLinksForGroup = async (groupId: string): Promise<InviteLink[]> => {
  return db.select(inviteColumns).from(inviteLink).where(eq(inviteLink.groupId, groupId));
};

/**
 * The group's invites that can still be redeemed, newest first — what the
 * members screen lists so an admin can see who has an outstanding invite and
 * re-read or revoke the code.
 */
export const getOpenInvitesForGroup = async (groupId: string): Promise<InviteLinkListItem[]> => {
  const inviter = alias(user, "invitedByUser");

  const rows = await db
    .select({ ...inviteColumns, invitedByName: inviter.name })
    .from(inviteLink)
    .leftJoin(inviter, eq(inviteLink.invitedByUserId, inviter.id))
    .where(
      and(
        eq(inviteLink.groupId, groupId),
        isNull(inviteLink.usedAt),
        isNull(inviteLink.revokedAt),
        gt(inviteLink.expiresAt, new Date())
      )
    )
    .orderBy(desc(inviteLink.createdAt));

  return rows;
};

export const getInviteLinkById = async (inviteId: string): Promise<InviteLink | undefined> => {
  const [row] = await db
    .select(inviteColumns)
    .from(inviteLink)
    .where(eq(inviteLink.id, inviteId))
    .limit(1);

  return row;
};

/**
 * Retires the open invite for (group, email) if there is one, so re-inviting
 * the same address issues a fresh code instead of tripping the partial unique
 * index — and so the superseded code stops working.
 */
export const revokeOpenInviteForEmail = async (
  groupId: string,
  email: string,
  tx?: DbTransaction
): Promise<void> => {
  await (tx ?? db)
    .update(inviteLink)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(inviteLink.groupId, groupId),
        eq(inviteLink.email, email),
        isNull(inviteLink.usedAt),
        isNull(inviteLink.revokedAt)
      )
    );
};

export const revokeInviteLink = async (inviteId: string): Promise<InviteLink | undefined> => {
  const [row] = await db
    .update(inviteLink)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(inviteLink.id, inviteId), isNull(inviteLink.usedAt), isNull(inviteLink.revokedAt))
    )
    .returning(inviteColumns);

  return row;
};

export const getInviteLinkByCode = async (
  code: string,
  tx?: DbTransaction
): Promise<InviteLink | undefined> => {
  const [row] = await (tx ?? db)
    .select(inviteColumns)
    .from(inviteLink)
    .where(eq(inviteLink.code, code))
    .limit(1);

  return row;
};

export const getInviteLinkBySecretHash = async (
  linkSecretHash: string,
  tx?: DbTransaction
): Promise<InviteLink | undefined> => {
  const [row] = await (tx ?? db)
    .select(inviteColumns)
    .from(inviteLink)
    .where(eq(inviteLink.linkSecretHash, linkSecretHash))
    .limit(1);

  return row;
};

export const getInvitePreviewBySecretHash = async (
  linkSecretHash: string
): Promise<InvitePreview | undefined> => {
  const inviter = alias(user, "invitedByUser");

  const [row] = await db
    .select({
      groupId: inviteLink.groupId,
      groupName: groups.groupName,
      inviterName: inviter.name,
      invitedEmail: inviteLink.email,
      usedAt: inviteLink.usedAt,
      revokedAt: inviteLink.revokedAt,
      expiresAt: inviteLink.expiresAt,
    })
    .from(inviteLink)
    .innerJoin(groups, eq(inviteLink.groupId, groups.id))
    .leftJoin(inviter, eq(inviteLink.invitedByUserId, inviter.id))
    .where(eq(inviteLink.linkSecretHash, linkSecretHash))
    .limit(1);

  // Only email-bound invites carry a link, so a null address cannot occur;
  // the check keeps the type honest.
  if (!row?.invitedEmail) return undefined;

  return {
    groupId: row.groupId,
    groupName: row.groupName,
    inviterName: row.inviterName,
    invitedEmail: row.invitedEmail,
    status: inviteStatus(row),
    expiresAt: row.expiresAt,
  };
};

/**
 * Marks the code as redeemed. The `usedAt IS NULL` predicate is what makes an
 * invite single-use even under concurrent redemptions: the second update
 * matches no row and the caller rolls back.
 */
export const useInviteLink = async (
  code: string,
  tx?: DbTransaction
): Promise<InviteLink | undefined> => {
  const [row] = await (tx ?? db)
    .update(inviteLink)
    .set({ usedAt: new Date() })
    .where(and(eq(inviteLink.code, code), isNull(inviteLink.usedAt), isNull(inviteLink.revokedAt)))
    .returning(inviteColumns);

  return row;
};

/**
 * Open (redeemable) invites for a group. The billing member-cap guard counts
 * these alongside live members, otherwise parallel redemptions overfill a
 * group past its plan limit.
 */
export const countOpenInvitesForGroup = async (
  groupId: string,
  tx?: DbTransaction
): Promise<number> => {
  const [row] = await (tx ?? db)
    .select({ value: count() })
    .from(inviteLink)
    .where(
      and(
        eq(inviteLink.groupId, groupId),
        isNull(inviteLink.usedAt),
        isNull(inviteLink.revokedAt),
        gt(inviteLink.expiresAt, new Date())
      )
    );
  return Number(row?.value ?? 0);
};
