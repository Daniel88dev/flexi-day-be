import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";

export const externalWorkerPairKey = (userId: string, groupId: string) => `${userId}::${groupId}`;

/**
 * Which of the given (person, group) pairs belong to an External worker: the
 * person's open Employment in the group's organization has the external type.
 * Answers with the pairs as `userId::groupId` keys.
 */
export const externalWorkerPairs = async (
  pairs: { userId: string; groupId: string }[],
  tx?: DbTransaction
): Promise<Set<string>> => {
  if (pairs.length === 0) return new Set();
  const rows = await (tx ?? db)
    .select({ userId: employments.userId, groupId: groups.id })
    .from(employments)
    .innerJoin(groups, eq(groups.organizationId, employments.organizationId))
    .where(
      and(
        inArray(groups.id, [...new Set(pairs.map((pair) => pair.groupId))]),
        inArray(employments.userId, [...new Set(pairs.map((pair) => pair.userId))]),
        isNull(employments.endedAt),
        eq(employments.type, workerType.External)
      )
    );
  const external = new Set(rows.map((row) => externalWorkerPairKey(row.userId!, row.groupId)));
  return new Set(
    pairs
      .map((pair) => externalWorkerPairKey(pair.userId, pair.groupId))
      .filter((key) => external.has(key))
  );
};

export const isExternalWorkerIn = async (
  userId: string,
  groupId: string,
  tx?: DbTransaction
): Promise<boolean> => (await externalWorkerPairs([{ userId, groupId }], tx)).size > 0;
