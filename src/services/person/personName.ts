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
type PersonColumns = { id: AnyPgColumn; name: AnyPgColumn };

/**
 * A person's display name, as an SQL expression over a `user` row. Every
 * reader that shows someone's name to someone else selects it through here
 * rather than reading `user.name`, so what a name means is decided in one
 * place. It is the account's name today; account deletion changes this body to
 * read the Employment's frozen copy in the scope's organization instead.
 */
export const personName = (person: PersonColumns, _scope: PersonScope): SQL<string> =>
  sql<string>`${person.name}`;

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
