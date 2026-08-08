import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import type { GroupMirror, GroupMirrorListItem } from "./types.js";

/** The caller's active mirrors into one group, with the source group's name. */
export const getMirrorsIntoGroupForUser = async (
  userId: string,
  targetGroupId: string,
  tx?: DbTransaction
): Promise<GroupMirrorListItem[]> => {
  const rows = await (tx ?? db)
    .select({
      id: groupMirrors.id,
      userId: groupMirrors.userId,
      sourceGroupId: groupMirrors.sourceGroupId,
      targetGroupId: groupMirrors.targetGroupId,
      deletedAt: groupMirrors.deletedAt,
      createdAt: groupMirrors.createdAt,
      updatedAt: groupMirrors.updatedAt,
      sourceGroupName: groups.groupName,
    })
    .from(groupMirrors)
    .innerJoin(groups, eq(groupMirrors.sourceGroupId, groups.id))
    .where(
      and(
        eq(groupMirrors.userId, userId),
        eq(groupMirrors.targetGroupId, targetGroupId),
        isNull(groupMirrors.deletedAt),
        isNull(groups.deletedAt)
      )
    );

  return rows;
};

/** Every active mirror the user has, in any direction. */
export const getMirrorsForUser = async (userId: string): Promise<GroupMirror[]> => {
  return db
    .select()
    .from(groupMirrors)
    .where(and(eq(groupMirrors.userId, userId), isNull(groupMirrors.deletedAt)));
};

/** Whether the user's records are projected into this group from elsewhere. */
export const hasMirrorIntoGroup = async (
  userId: string,
  targetGroupId: string,
  tx?: DbTransaction
): Promise<boolean> => {
  const [row] = await (tx ?? db)
    .select({ id: groupMirrors.id })
    .from(groupMirrors)
    .where(
      and(
        eq(groupMirrors.userId, userId),
        eq(groupMirrors.targetGroupId, targetGroupId),
        isNull(groupMirrors.deletedAt)
      )
    )
    .limit(1);

  return row !== undefined;
};

/** The active mirror sources for several members of one group, at once. */
export const getMirrorsIntoGroupForUsers = async (
  userIds: string[],
  targetGroupId: string,
  tx?: DbTransaction
): Promise<{ userId: string; sourceGroupId: string; sourceGroupName: string }[]> => {
  if (userIds.length === 0) return [];
  return (tx ?? db)
    .select({
      userId: groupMirrors.userId,
      sourceGroupId: groupMirrors.sourceGroupId,
      sourceGroupName: groups.groupName,
    })
    .from(groupMirrors)
    .innerJoin(groups, eq(groupMirrors.sourceGroupId, groups.id))
    .where(
      and(
        inArray(groupMirrors.userId, userIds),
        eq(groupMirrors.targetGroupId, targetGroupId),
        isNull(groupMirrors.deletedAt),
        isNull(groups.deletedAt)
      )
    );
};

/**
 * Makes the user's mirrors into `targetGroupId` exactly `sourceGroupIds`,
 * *within* `manageableSourceGroupIds` — an admin sees only some of a member's
 * groups, and the rest must survive a save rather than read as a removal.
 * Diffed rather than wiped so an untouched mirror keeps its `createdAt`.
 * Callers must have already verified membership of the target and every source.
 */
export const setMirrorsIntoGroupForUser = async (
  userId: string,
  targetGroupId: string,
  sourceGroupIds: string[],
  manageableSourceGroupIds: string[],
  tx?: DbTransaction
): Promise<GroupMirrorListItem[]> => {
  const runner = tx ?? db;

  const existing = await runner
    .select({ sourceGroupId: groupMirrors.sourceGroupId })
    .from(groupMirrors)
    .where(
      and(
        eq(groupMirrors.userId, userId),
        eq(groupMirrors.targetGroupId, targetGroupId),
        isNull(groupMirrors.deletedAt)
      )
    );

  const existingIds = new Set(existing.map((row) => row.sourceGroupId));

  const removed = manageableSourceGroupIds.filter(
    (id) => existingIds.has(id) && !sourceGroupIds.includes(id)
  );

  if (removed.length > 0) {
    await runner
      .update(groupMirrors)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(groupMirrors.userId, userId),
          eq(groupMirrors.targetGroupId, targetGroupId),
          isNull(groupMirrors.deletedAt),
          inArray(groupMirrors.sourceGroupId, removed)
        )
      );
  }

  const added = sourceGroupIds.filter((id) => !existingIds.has(id));

  if (added.length > 0) {
    await runner.insert(groupMirrors).values(
      added.map((sourceGroupId) => ({
        id: generateRandomUUID(),
        userId,
        sourceGroupId,
        targetGroupId,
      }))
    );
  }

  return getMirrorsIntoGroupForUser(userId, targetGroupId, tx);
};
