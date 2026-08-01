import { and, eq, isNull, notInArray } from "drizzle-orm";
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

/**
 * Makes the user's mirrors into `targetGroupId` exactly `sourceGroupIds`.
 * Diffed rather than wiped and re-inserted so an untouched mirror keeps its
 * original `createdAt`. Callers must have already verified the user is an
 * active member of the target and of every source group.
 */
export const setMirrorsIntoGroupForUser = async (
  userId: string,
  targetGroupId: string,
  sourceGroupIds: string[],
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

  const removedBase = and(
    eq(groupMirrors.userId, userId),
    eq(groupMirrors.targetGroupId, targetGroupId),
    isNull(groupMirrors.deletedAt)
  );

  await runner
    .update(groupMirrors)
    .set({ deletedAt: new Date() })
    .where(
      sourceGroupIds.length === 0
        ? removedBase
        : and(removedBase, notInArray(groupMirrors.sourceGroupId, sourceGroupIds))
    );

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
