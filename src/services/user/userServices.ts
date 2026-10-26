import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

export type UserContact = {
  id: string;
  name: string;
  email: string;
};

export const getUserById = async (
  userId: string,
  tx?: DbTransaction
): Promise<UserContact | undefined> => {
  const [row] = await (tx ?? db)
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  return row;
};

/**
 * Looks a user up by email. `user.email` is uniquely indexed, so this matches
 * at most one row. Callers must pass an already lower-cased address —
 * better-auth stores emails lower-cased.
 */
export const getUserByEmail = async (
  email: string,
  tx?: DbTransaction
): Promise<UserContact | undefined> => {
  const [row] = await (tx ?? db)
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  return row;
};

/**
 * Contact details for a set of users. Used by the notifier, which resolves
 * every recipient of a batch in one query.
 */
export const getUsersByIds = async (userIds: string[]): Promise<UserContact[]> => {
  if (userIds.length === 0) return [];
  return db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, userIds));
};

export const markEmailVerified = async (userId: string, tx?: DbTransaction): Promise<void> => {
  await (tx ?? db)
    .update(user)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(user.id, userId));
};

/** Sessions and provider accounts go with the row, through their cascading foreign keys. */
export const deleteUser = async (userId: string): Promise<void> => {
  await db.delete(user).where(eq(user.id, userId));
};

/** Deletes the user only when both the id and the address match; reports whether a row went. */
export const deleteUserByIdAndEmail = async (userId: string, email: string): Promise<boolean> => {
  const removed = await db
    .delete(user)
    .where(and(eq(user.id, userId), eq(user.email, email)))
    .returning({ id: user.id });
  return removed.length > 0;
};

/**
 * Whether the user is a Deleted account. Inside a transaction it waits on an
 * account deletion holding the row, so a write that checks first cannot land
 * after the deletion commits.
 */
export const isDeletedAccount = async (userId: string, tx?: DbTransaction): Promise<boolean> => {
  const query = (tx ?? db)
    .select({ deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const [row] = await (tx ? query.for("key share") : query);
  return Boolean(row?.deletedAt);
};

/** The ids among `userIds` that are Deleted accounts. */
export const deletedAccountIds = async (userIds: string[]): Promise<Set<string>> => {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.id, userIds), isNotNull(user.deletedAt)));
  return new Set(rows.map((row) => row.id));
};
