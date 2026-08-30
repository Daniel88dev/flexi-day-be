import { db, type DbTransaction } from "../../db/db.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getUserById } from "../user/userServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import AppError from "../../utils/appError.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import type {
  OrganizationAdminListItem,
  OrganizationCandidate,
  OrganizationType,
} from "./types.js";

export const getOrganizationById = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<OrganizationType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return row;
};

export const getOrganizationForOwner = async (
  ownerUserId: string,
  tx?: DbTransaction
): Promise<OrganizationType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(organizations)
    .where(eq(organizations.ownerUserId, ownerUserId))
    .limit(1);

  return row;
};

/**
 * Lazily creates the user's organization on first need (group creation).
 * Users with no groups get no row. Safe under concurrency: the unique index
 * on `owner_user_id` makes the insert a no-op for the loser, who re-selects.
 */
export const ensureOrganizationForUser = async (
  userId: string,
  tx?: DbTransaction
): Promise<OrganizationType> => {
  const existing = await getOrganizationForOwner(userId, tx);
  if (existing) return existing;

  const owner = await getUserById(userId, tx);
  if (!owner) {
    throw new AppError({
      message: "User not found",
      logging: true,
      code: 404,
      context: { userId },
    });
  }

  const [created] = await (tx ?? db)
    .insert(organizations)
    .values({
      id: generateRandomUUID(),
      name: owner.name,
      ownerUserId: userId,
      billingEmail: owner.email,
    })
    .onConflictDoNothing({ target: organizations.ownerUserId })
    .returning();

  if (created) return created;

  const raced = await getOrganizationForOwner(userId, tx);
  if (!raced) {
    throw new AppError({
      message: "Failed to create organization",
      logging: true,
      code: 500,
      context: { userId },
    });
  }
  return raced;
};

export const setOrganizationPaddleCustomerId = async (
  organizationId: string,
  paddleCustomerId: string,
  tx?: DbTransaction
): Promise<OrganizationType | undefined> => {
  const [row] = await (tx ?? db)
    .update(organizations)
    .set({ paddleCustomerId })
    .where(eq(organizations.id, organizationId))
    .returning();

  return row;
};

export const updateOrganization = async (
  organizationId: string,
  patch: { name?: string; billingEmail?: string; sickDayBenefitEnabled?: boolean },
  tx?: DbTransaction
): Promise<OrganizationType | undefined> => {
  const [row] = await (tx ?? db)
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, organizationId))
    .returning();

  return row;
};

/**
 * True for the owner as well as anyone holding an active `organization_users`
 * row. The owner is deliberately not stored in that table, so a caller that
 * queries it alone answers only half the question.
 *
 * Two lookups rather than one join-with-`OR`: an `OR` spanning the outer table
 * and a nullable joined table cannot be driven by either index, and this runs
 * on every group-scoped authorization check.
 */
export const isOrganizationAdmin = async (
  userId: string,
  organizationId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const [owned] = await (tx ?? db)
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), eq(organizations.ownerUserId, userId)))
    .limit(1);

  if (owned) return true;

  const [granted] = await (tx ?? db)
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(
      and(
        eq(organizationUsers.organizationId, organizationId),
        eq(organizationUsers.userId, userId),
        isNull(organizationUsers.deletedAt)
      )
    )
    .limit(1);

  return granted !== undefined;
};

const organizationColumns = {
  id: organizations.id,
  name: organizations.name,
  ownerUserId: organizations.ownerUserId,
  billingEmail: organizations.billingEmail,
  paddleCustomerId: organizations.paddleCustomerId,
  sickDayBenefitEnabled: organizations.sickDayBenefitEnabled,
  createdAt: organizations.createdAt,
  updatedAt: organizations.updatedAt,
};

/**
 * Organizations the user owns or administers — owned first, then oldest first.
 * Split into two index-backed queries for the same reason as
 * {@link isOrganizationAdmin}.
 */
export const getAdminOrganizationsForUser = async (
  userId: string,
  tx?: DbTransaction
): Promise<OrganizationType[]> => {
  const owned = await (tx ?? db)
    .select(organizationColumns)
    .from(organizations)
    .where(eq(organizations.ownerUserId, userId))
    .orderBy(asc(organizations.createdAt));

  const granted = await (tx ?? db)
    .select(organizationColumns)
    .from(organizationUsers)
    .innerJoin(organizations, eq(organizationUsers.organizationId, organizations.id))
    .where(and(eq(organizationUsers.userId, userId), isNull(organizationUsers.deletedAt)))
    .orderBy(asc(organizations.createdAt));

  // A grant on an organization you already own is not representable (the owner
  // holds no row), but de-duplicate anyway rather than trust that invariant.
  const ownedIds = new Set(owned.map((organization) => organization.id));
  return [...owned, ...granted.filter((organization) => !ownedIds.has(organization.id))];
};

/** The owner first, then delegated admins by name. */
export const listOrganizationAdmins = async (
  organizationId: string
): Promise<OrganizationAdminListItem[]> => {
  const [organization] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!organization) return [];

  const owner = await getUserById(organization.ownerUserId);

  const rows = await db
    .select({
      userId: organizationUsers.userId,
      grantedAt: organizationUsers.createdAt,
      userName: user.name,
      email: user.email,
    })
    .from(organizationUsers)
    .innerJoin(user, eq(organizationUsers.userId, user.id))
    .where(
      and(eq(organizationUsers.organizationId, organizationId), isNull(organizationUsers.deletedAt))
    )
    .orderBy(asc(user.name));

  return [
    ...(owner
      ? [
          {
            userId: owner.id,
            email: owner.email,
            isOwner: true,
            grantedAt: null,
            user: buildUserSummary(owner),
          },
        ]
      : []),
    // The owner never holds a row, so this cannot duplicate them.
    ...rows.map(({ userName, ...rest }) => ({
      ...rest,
      isOwner: false,
      user: buildUserSummary({ id: rest.userId, name: userName }),
    })),
  ];
};

/**
 * People who can be promoted to org admin: active members of the org's live
 * groups, minus the owner and anyone already an admin. Restricting the pool to
 * the org's own people is what lets the endpoint avoid an email lookup, which
 * would otherwise let any owner probe whether an address has an account.
 */
export const listOrganizationAdminCandidates = async (
  organizationId: string
): Promise<OrganizationCandidate[]> => {
  const rows = await db
    .selectDistinct({
      userId: groupUsers.userId,
      userName: user.name,
      email: user.email,
      groupName: groups.groupName,
    })
    .from(groupUsers)
    .innerJoin(groups, eq(groupUsers.groupId, groups.id))
    .innerJoin(user, eq(groupUsers.userId, user.id))
    .where(
      and(
        eq(groups.organizationId, organizationId),
        isNull(groups.deletedAt),
        isNull(groupUsers.deletedAt)
      )
    )
    .orderBy(asc(user.name));

  const admins = await listOrganizationAdmins(organizationId);
  const excluded = new Set(admins.map((admin) => admin.userId));

  const byUser = new Map<string, OrganizationCandidate>();
  for (const row of rows) {
    if (excluded.has(row.userId)) continue;
    const existing = byUser.get(row.userId);
    if (existing) {
      existing.groupNames.push(row.groupName);
      continue;
    }
    byUser.set(row.userId, {
      userId: row.userId,
      email: row.email,
      groupNames: [row.groupName],
      user: buildUserSummary({ id: row.userId, name: row.userName }),
    });
  }

  return [...byUser.values()];
};

/**
 * Grants org admin. Re-granting someone previously removed revives their row
 * rather than inserting: the unique index only covers live rows, so repeated
 * grant/revoke cycles would otherwise pile up a row each time.
 */
export const grantOrganizationAdmin = async (input: {
  organizationId: string;
  userId: string;
  grantedByUserId: string;
  /**
   * Re-checked inside the transaction, under the organization lock. The
   * caller's own check races the revocation in `handleDeleteGroupUser`: it
   * takes the same lock, so without this a grant could be written for someone
   * whose last membership was removed concurrently — and nothing would ever
   * auto-revoke it, since there is no membership left to remove.
   */
  assertStillEligible?: (tx: DbTransaction) => Promise<boolean>;
}): Promise<void> => {
  await db.transaction(async (tx) => {
    await lockOrganization(input.organizationId, tx);

    if (input.assertStillEligible && !(await input.assertStillEligible(tx))) {
      throw new AppError({
        message: "This user is not a member of any group in this organization",
        logging: true,
        code: 422,
        context: { organizationId: input.organizationId, target: input.userId },
      });
    }

    const revived = await tx
      .update(organizationUsers)
      .set({ deletedAt: null, grantedByUserId: input.grantedByUserId })
      .where(
        and(
          eq(organizationUsers.organizationId, input.organizationId),
          eq(organizationUsers.userId, input.userId)
        )
      )
      .returning({ id: organizationUsers.id });

    if (revived.length > 0) return;

    await tx
      .insert(organizationUsers)
      .values({
        id: generateRandomUUID(),
        organizationId: input.organizationId,
        userId: input.userId,
        grantedByUserId: input.grantedByUserId,
      })
      .onConflictDoNothing();
  });
};

export const removeOrganizationAdmin = async (
  organizationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const removed = await (tx ?? db)
    .update(organizationUsers)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(organizationUsers.organizationId, organizationId),
        eq(organizationUsers.userId, userId),
        isNull(organizationUsers.deletedAt)
      )
    )
    .returning({ id: organizationUsers.id });

  return removed.length > 0;
};

/**
 * Of the given groups, the ones whose organization has the Sick day benefit
 * switched on. Deliberately the stored toggle rather than live entitlements:
 * reporting keeps showing the allowances and usage a lapsed organization
 * accrued, while requestability is what goes dormant (`isSickDayBenefitActive`).
 */
export const getSickDayEnabledGroupIds = async (
  groupIds: string[],
  tx?: DbTransaction
): Promise<Set<string>> => {
  if (groupIds.length === 0) return new Set();

  const rows = await (tx ?? db)
    .select({ id: groups.id })
    .from(groups)
    .innerJoin(organizations, eq(groups.organizationId, organizations.id))
    .where(and(inArray(groups.id, groupIds), eq(organizations.sickDayBenefitEnabled, true)));

  return new Set(rows.map((row) => row.id));
};

/** Bulk lookup for the per-group organization badge — one query, not one per group. */
export const getOrganizationsByIds = async (
  organizationIds: string[],
  tx?: DbTransaction
): Promise<OrganizationType[]> => {
  if (organizationIds.length === 0) return [];
  return (tx ?? db).select().from(organizations).where(inArray(organizations.id, organizationIds));
};

/**
 * Row-locks the organization for the rest of the transaction. The group cap is
 * a plain `count(*)`, so without this two concurrent creates both see the
 * pre-insert count and both succeed, leaving the org permanently over its plan.
 */
export const lockOrganization = async (
  organizationId: string,
  tx: DbTransaction
): Promise<void> => {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");

  // `FOR UPDATE` matching no row locks nothing and returns silently, which
  // would quietly turn every caller's count-then-act back into a race.
  if (!row) {
    throw new AppError({
      message: "Organization not found",
      logging: true,
      code: 500,
      context: { organizationId },
    });
  }
};
