import { eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";

/**
 * The organization whose records show the name, named directly or through one
 * of its groups. A column of the reader's query or a literal id.
 */
export type PersonScope =
  { organizationId: SQLWrapper | string } | { groupId: SQLWrapper | string };

/** `user`, or an alias of it. */
type PersonColumns = { id: AnyPgColumn; name: AnyPgColumn; deletedAt: AnyPgColumn };

export const DELETED_ACCOUNT_NAME = "Deleted account";

const scopeOrganization = (scope: PersonScope): SQL =>
  "organizationId" in scope
    ? sql`${scope.organizationId}`
    : sql`(select "pn_g"."organization_id" from "groups" "pn_g" where "pn_g"."id" = ${scope.groupId})`;

/**
 * A person's display name, as an SQL expression over a `user` row. Every
 * reader that shows someone's name to someone else selects it through here
 * rather than reading `user.name`, so what a name means is decided in one
 * place: the account's name, or for a Deleted account the frozen copy on its
 * Employment in the scope's organization, and "Deleted account" once that
 * organization holds no Employment for them. The subqueries use their own
 * aliases so a reader that selects from `employments` or `groups` keeps its
 * own columns.
 */
export const personName = (person: PersonColumns, scope: PersonScope): SQL<string> =>
  sql<string>`case when ${person.deletedAt} is null then ${person.name} else coalesce(
    (select "pn_e"."name" from "employments" "pn_e"
      where "pn_e"."user_id" = ${person.id}
        and "pn_e"."organization_id" = ${scopeOrganization(scope)}
      order by "pn_e"."started_at" desc limit 1),
    ${DELETED_ACCOUNT_NAME}) end`;

/** Whether the person deleted their account, for the readers that show the label. */
export const isDeletedAccount = (person: Pick<PersonColumns, "deletedAt">): SQL<boolean> =>
  sql<boolean>`(${person.deletedAt} is not null)`.mapWith(Boolean);

/** {@link personName} for a left-joined alias, which may match no row. */
export const optionalPersonName = (person: PersonColumns, scope: PersonScope): SQL<string | null> =>
  personName(person, scope);

export type PersonContact = { id: string; name: string; email: string };

/** Name and email of each user, for readers that start from ids rather than a join. */
export const getPersonContacts = async (
  userIds: string[],
  scope: PersonScope,
  tx?: DbTransaction
): Promise<PersonContact[]> => {
  if (userIds.length === 0) return [];
  return (tx ?? db)
    .select({ id: user.id, name: personName(user, scope), email: user.email })
    .from(user)
    .where(inArray(user.id, userIds));
};

/** {@link getPersonContacts} for one user. */
export const getPersonContact = async (
  userId: string,
  scope: PersonScope,
  tx?: DbTransaction
): Promise<PersonContact | undefined> => {
  const [row] = await (tx ?? db)
    .select({ id: user.id, name: personName(user, scope), email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row;
};
