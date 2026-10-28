import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, type DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";

type Operand = AnyPgColumn | string;

/**
 * The four links of ADR 0004 that tie an account holder to an organization:
 * they own it, hold a live delegated admin row, manage one of its live groups,
 * or belong to one. The roster invariant (`syncEmployment`) and every read of
 * who the organization still links derive from these.
 */
const organizationLinks = (organizationId: Operand, userId: Operand) => ({
  owner: sql`exists (
    select 1 from ${organizations}
    where ${organizations.id} = ${organizationId}
      and ${organizations.ownerUserId} = ${userId})`,
  delegatedAdmin: sql`exists (
    select 1 from ${organizationUsers}
    where ${organizationUsers.organizationId} = ${organizationId}
      and ${organizationUsers.userId} = ${userId}
      and ${organizationUsers.deletedAt} is null)`,
  managedGroup: sql`exists (
    select 1 from ${groups}
    where ${groups.organizationId} = ${organizationId}
      and ${groups.managerUserId} = ${userId}
      and ${groups.deletedAt} is null)`,
  groupMembership: sql`exists (
    select 1 from ${groupUsers}
    inner join ${groups} on ${groups.id} = ${groupUsers.groupId}
    where ${groups.organizationId} = ${organizationId}
      and ${groupUsers.userId} = ${userId}
      and ${groupUsers.deletedAt} is null
      and ${groups.deletedAt} is null)`,
});

const holds = async (link: SQL, client: DbTransaction | typeof db): Promise<boolean> => {
  const { rows } = await client.execute<{ linked: boolean }>(sql`select ${link} as linked`);
  return rows[0]?.linked === true;
};

/**
 * Whether the person is still reachable from the organization by any of the
 * four links. Deliberately four indexed lookups rather than one `OR`, for the
 * reason `isOrganizationAdmin` gives: no index drives an `OR` spanning four
 * tables.
 */
export const hasOrganizationLink = async (
  userId: string,
  organizationId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const client = tx ?? db;
  const links = organizationLinks(organizationId, userId);
  for (const link of [
    links.owner,
    links.delegatedAdmin,
    links.managedGroup,
    links.groupMembership,
  ]) {
    if (await holds(link, client)) return true;
  }
  return false;
};

/**
 * Open Employments none of the four links holds: people without an account and
 * account holders who belong to nothing. A Directory organization keeps them
 * open; with the directory off only End employment ends them.
 */
export const unlinkedOpenEmploymentIds = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<Set<string>> => {
  const links = organizationLinks(employments.organizationId, employments.userId);
  const rows = await (tx ?? db)
    .select({ id: employments.id })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        isNull(employments.endedAt),
        or(
          isNull(employments.userId),
          sql`not (${links.owner} or ${links.delegatedAdmin} or ${links.managedGroup} or ${links.groupMembership})`
        )
      )
    );
  return new Set(rows.map((row) => row.id));
};

/** Account holders with an open Employment whom the organization links through a group: a live membership or a managed group. */
export const groupedUserIds = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<Set<string>> => {
  const links = organizationLinks(employments.organizationId, employments.userId);
  const rows = await (tx ?? db)
    .selectDistinct({ userId: employments.userId })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        isNull(employments.endedAt),
        isNotNull(employments.userId),
        or(links.managedGroup, links.groupMembership)
      )
    );
  return new Set(rows.flatMap((row) => (row.userId === null ? [] : [row.userId])));
};
