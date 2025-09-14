import { db } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { and, eq, isNull } from "drizzle-orm";
import type { GroupUser } from "./types.js";

/**
 * Retrieves a user and their association with a specified group.
 *
 * This function fetches the user's details within the context of a particular group,
 * excluding records that have been marked as deleted. If no matching record is found,
 * it returns undefined.
 *
 * @param {string} userId - The unique identifier of the user.
 * @param {string} groupId - The unique identifier of the group.
 * @returns {Promise<GroupUser | undefined>} A promise that resolves to the user's group association details,
 * or undefined if no matching record is found.
 */
export const getGroupUser = async (
  userId: string,
  groupId: string
): Promise<GroupUser | undefined> => {
  const result = await db
    .select()
    .from(groupUsers)
    .where(
      and(
        eq(groupUsers.userId, userId),
        eq(groupUsers.groupId, groupId),
        isNull(groupUsers.deletedAt)
      )
    )
    .limit(1);

  return result[0];
};
