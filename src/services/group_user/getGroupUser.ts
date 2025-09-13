import { db } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { and, eq, isNull } from "drizzle-orm";
import type { GroupUser } from "./types.js";

export const getGroupUser = async (
  userId: string,
  groupId: string
): Promise<GroupUser[]> => {
  return db
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
};
