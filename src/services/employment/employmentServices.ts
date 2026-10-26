import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import type { BoundEmploymentType, EmploymentListItem, EmploymentType } from "./types.js";
import { assertNoAccountlessClash, lockEmploymentEmail } from "./accountlessClash.js";
import { personName } from "../person/personName.js";
import { roleChangeReason } from "../../db/schema/directory-role-schema.js";
import { endDirectoryRoles } from "../directory/directoryRoleServices.js";

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
 * A link with no open spell starts a new Employment; an ended one is never
 * reopened. It is refused with a 409 when an open account-less Employment in
 * the organization holds the account's email.
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
    const [account] = await client
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!account) return;

    // Also what keeps two joins of one person from both inserting a spell.
    await lockEmploymentEmail(organizationId, account.email, client);
    // A member joining a second group must not restart the spell attendance is
    // measured from.
    if (await getOpenEmployment(organizationId, userId, tx)) return;

    await assertNoAccountlessClash(organizationId, account.email, { userId }, tx);
    await client.insert(employments).values({
      id: generateRandomUUID(),
      organizationId,
      userId,
      name: account.name,
      email: account.email,
    });
    return;
  }

  const ended = await client
    .update(employments)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(employments.organizationId, organizationId),
        eq(employments.userId, userId),
        isNull(employments.endedAt)
      )
    )
    .returning({ id: employments.id });
  await endDirectoryRoles(
    {
      employmentIds: ended.map((row) => row.id),
      reason: roleChangeReason.EmploymentEnded,
      actorUserId: null,
    },
    tx
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

const getOpenEmployment = async (
  organizationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<{ id: string } | undefined> => {
  const [row] = await (tx ?? db)
    .select({ id: employments.id })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        eq(employments.userId, userId),
        isNull(employments.endedAt)
      )
    )
    .limit(1);
  return row;
};

/**
 * The person's current spell in the organization: the open one, else the one
 * that ended last.
 */
export const getEmployment = async (
  organizationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<BoundEmploymentType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(employments)
    .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)))
    .orderBy(sql`${employments.endedAt} desc nulls first`, desc(employments.startedAt))
    .limit(1);

  return row ? { ...row, userId } : undefined;
};

/**
 * Narrows an Employment that attendance hangs off. Nobody clocks in for, or
 * enters attendance on behalf of, a person without an account, so a session on
 * an account-less Employment is a broken invariant rather than a request error.
 */
export const asBoundEmployment = (employment: EmploymentType): BoundEmploymentType => {
  const { userId } = employment;
  if (userId === null) {
    throw new AppError({
      message: "Attendance reached an Employment without an account",
      logging: true,
      code: 500,
      context: { employmentId: employment.id },
    });
  }
  return { ...employment, userId };
};

export const getEmploymentById = async (
  employmentId: string,
  tx?: DbTransaction
): Promise<EmploymentType | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(employments)
    .where(eq(employments.id, employmentId))
    .limit(1);

  return row;
};

/**
 * The per-person override of the organization's required minutes per day. Null
 * clears it; nothing else on the row is an admin's to set, which is why this
 * takes the one value rather than a patch object.
 */
export const setEmploymentRequiredMinutes = async (
  employmentId: string,
  requiredMinutesPerDay: number | null,
  tx?: DbTransaction
): Promise<EmploymentType> => {
  const [row] = await (tx ?? db)
    .update(employments)
    .set({ requiredMinutesPerDay })
    .where(eq(employments.id, employmentId))
    .returning();

  if (!row) {
    throw new AppError({
      message: "Employment not found",
      logging: true,
      code: 404,
      context: { employmentId },
    });
  }

  return row;
};

/**
 * The organization's roster: open Employments by name, then ended ones by end
 * date, most recent first. `userIds` narrows it to the people a
 * group admin may see; an empty array means nobody, never everybody. `active`
 * drops the ended spells, which the team dashboard has no column for.
 */
export const listEmployments = async (
  organizationId: string,
  options?: { userIds?: string[]; active?: boolean },
  tx?: DbTransaction
): Promise<EmploymentListItem[]> => {
  if (options?.userIds?.length === 0) return [];

  // A person without an account has no user row: the Employment's copy names them.
  const name = sql<string>`coalesce(${personName(user, { organizationId })}, ${employments.name}, '')`;
  const rows = await (tx ?? db)
    .select({
      id: employments.id,
      userId: employments.userId,
      type: employments.type,
      startedAt: employments.startedAt,
      endedAt: employments.endedAt,
      requiredMinutesPerDay: employments.requiredMinutesPerDay,
      accountDeletedAt: employments.accountDeletedAt,
      userName: name,
      email: sql<string | null>`coalesce(${user.email}, ${employments.email})`,
    })
    .from(employments)
    .leftJoin(user, eq(employments.userId, user.id))
    .where(
      and(
        eq(employments.organizationId, organizationId),
        options?.userIds ? inArray(employments.userId, options.userIds) : undefined,
        options?.active ? isNull(employments.endedAt) : undefined
      )
    )
    .orderBy(sql`${employments.endedAt} desc nulls first`, asc(name));

  return rows.map(({ userName, ...row }) => ({
    ...row,
    ended: row.endedAt !== null,
    accountDeleted: row.accountDeletedAt !== null,
    // Keyed on the Employment when there is no account, so the summary still has an id.
    user: buildUserSummary({ id: row.userId ?? row.id, name: userName }),
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
