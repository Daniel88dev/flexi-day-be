import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { eq, inArray } from "drizzle-orm";

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
