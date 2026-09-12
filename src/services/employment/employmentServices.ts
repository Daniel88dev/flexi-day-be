import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import type { EmploymentListItem, EmploymentType } from "./types.js";

/**
 * Whether the person is still reachable from the organization by any of the
 * four links ADR 0004 names: they own it, hold a live delegated admin row,
 * manage one of its live groups, or belong to one. Deliberately four indexed
 * lookups rather than one union-with-`OR`, for the reason `isOrganizationAdmin`
 * gives: no index drives an `OR` spanning four tables.
 */
const hasOrganizationLink = async (
  userId: string,
  organizationId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const client = tx ?? db;

  const [owned] = await client
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), eq(organizations.ownerUserId, userId)))
    .limit(1);
  if (owned) return true;

  const [delegated] = await client
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
  if (delegated) return true;

  const [managed] = await client
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(
        eq(groups.organizationId, organizationId),
        eq(groups.managerUserId, userId),
        isNull(groups.deletedAt)
      )
    )
    .limit(1);
  if (managed) return true;

  const [member] = await client
    .select({ id: groupUsers.id })
    .from(groupUsers)
    .innerJoin(groups, eq(groupUsers.groupId, groups.id))
    .where(
      and(
        eq(groups.organizationId, organizationId),
        eq(groupUsers.userId, userId),
        isNull(groupUsers.deletedAt),
        isNull(groups.deletedAt)
      )
    )
    .limit(1);

  return member !== undefined;
};

/**
 * Brings one person's Employment back in line with the links they actually
 * hold. Every path that joins someone to an organization or takes a link away
 * calls this, and it recomputes rather than applying a delta, so the order two
 * link changes land in does not matter: removing a member's last group and
 * revoking their admin grant in either order ends the Employment exactly once.
 *
 * Runs in the caller's transaction: the row that decides the answer is usually
 * one the caller just wrote and has not committed.
 */
export const syncEmployment = async (
  organizationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<void> => {
  const client = tx ?? db;

  if (await hasOrganizationLink(userId, organizationId, tx)) {
    await client
      .insert(employments)
      .values({ id: generateRandomUUID(), organizationId, userId })
      .onConflictDoUpdate({
        target: [employments.organizationId, employments.userId],
        set: { startedAt: sql`now()`, endedAt: null, updatedAt: sql`now()` },
        // An Employment that is already open is left alone: a member joining a
        // second group must not restart the spell attendance is measured from.
        setWhere: sql`${employments.endedAt} is not null`,
      });
    return;
  }

  await client
    .update(employments)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(employments.organizationId, organizationId),
        eq(employments.userId, userId),
        isNull(employments.endedAt)
      )
    );
};

/** {@link syncEmployment} for everyone a single change touches — group deletion. */
const syncEmployments = async (
  organizationId: string,
  userIds: string[],
  tx?: DbTransaction
): Promise<void> => {
  for (const userId of new Set(userIds)) {
    await syncEmployment(organizationId, userId, tx);
  }
};

export const getEmployment = async (
  organizationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<EmploymentType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(employments)
    .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)))
    .limit(1);

  return row;
};

/**
 * The organization's roster, by name. `userIds` narrows it to the people a
 * group admin may see; an empty array means nobody, never everybody.
 */
export const listEmployments = async (
  organizationId: string,
  options?: { userIds?: string[] },
  tx?: DbTransaction
): Promise<EmploymentListItem[]> => {
  if (options?.userIds?.length === 0) return [];

  const rows = await (tx ?? db)
    .select({
      id: employments.id,
      userId: employments.userId,
      startedAt: employments.startedAt,
      endedAt: employments.endedAt,
      userName: user.name,
      email: user.email,
    })
    .from(employments)
    .innerJoin(user, eq(employments.userId, user.id))
    .where(
      and(
        eq(employments.organizationId, organizationId),
        options?.userIds ? inArray(employments.userId, options.userIds) : undefined
      )
    )
    .orderBy(asc(user.name));

  return rows.map(({ userName, ...row }) => ({
    ...row,
    ended: row.endedAt !== null,
    user: buildUserSummary({ id: row.userId, name: userName }),
  }));
};

/** Headcount for the billing screen: people currently employed, not rows. */
export const countActiveEmployments = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<number> => {
  const [row] = await (tx ?? db)
    .select({ value: count() })
    .from(employments)
    .where(and(eq(employments.organizationId, organizationId), isNull(employments.endedAt)));

  return Number(row?.value ?? 0);
};

/** {@link syncEmployment} for a membership change, whose caller holds a group id rather than an organization's. */
export const syncEmploymentForGroup = async (
  groupId: string,
  userId: string,
  tx?: DbTransaction
): Promise<void> => {
  const [group] = await (tx ?? db)
    .select({ organizationId: groups.organizationId })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);

  if (!group) return;

  await syncEmployment(group.organizationId, userId, tx);
};

/**
 * {@link syncEmployment} for everyone a deleted group used to link: its manager
 * and its members. Their `group_users` rows stay live — it is the group that
 * went — so the links have to be re-evaluated one by one.
 */
export const syncEmploymentsForDeletedGroup = async (
  group: { id: string; organizationId: string; managerUserId: string },
  tx?: DbTransaction
): Promise<void> => {
  const members = await (tx ?? db)
    .selectDistinct({ userId: groupUsers.userId })
    .from(groupUsers)
    .where(and(eq(groupUsers.groupId, group.id), isNull(groupUsers.deletedAt)));

  await syncEmployments(
    group.organizationId,
    [group.managerUserId, ...members.map((member) => member.userId)],
    tx
  );
};

/**
 * Every Employment the person holds, oldest spell first, ended ones included —
 * the attendance endpoints resolve an unnamed organization from this, and an
 * ended row has to be in it or the refusal would read as "no employment here".
 */
export const listEmploymentsForUser = async (
  userId: string,
  tx?: DbTransaction
): Promise<EmploymentType[]> =>
  (tx ?? db)
    .select()
    .from(employments)
    .where(eq(employments.userId, userId))
    .orderBy(asc(employments.startedAt));
