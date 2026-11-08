import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../../db/db.js";
import {
  assistantRejectedTurns,
  type AssistantRejectionReason,
} from "../../../db/schema/assistant-schema.js";
import { generateRandomUUID } from "../../../utils/generateUUID.js";

export const recordRejectedTurn = async (args: {
  organizationId: string;
  userId: string;
  chatId: string;
  reason: AssistantRejectionReason;
}): Promise<void> => {
  await db.insert(assistantRejectedTurns).values({ id: generateRandomUUID(), ...args });
};

export type RejectedTurnCount = { offTopic: number; attack: number };

/** Monday 00:00 UTC of the current week, on the database clock like the Weekly limit. */
const weekStart = sql`date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/** Each person's rejected turns in the organization this week, by user id; people with none are absent. */
export const countRejectedTurnsThisWeek = async (
  organizationId: string
): Promise<Map<string, RejectedTurnCount>> => {
  const rows = await db
    .select({
      userId: assistantRejectedTurns.userId,
      reason: assistantRejectedTurns.reason,
      count: sql<number>`count(*)::int`,
    })
    .from(assistantRejectedTurns)
    .where(
      and(
        eq(assistantRejectedTurns.organizationId, organizationId),
        gte(assistantRejectedTurns.createdAt, weekStart)
      )
    )
    .groupBy(assistantRejectedTurns.userId, assistantRejectedTurns.reason);

  const counts = new Map<string, RejectedTurnCount>();
  for (const row of rows) {
    const count = counts.get(row.userId) ?? { offTopic: 0, attack: 0 };
    if (row.reason === "off_topic") count.offTopic += row.count;
    else count.attack += row.count;
    counts.set(row.userId, count);
  }
  return counts;
};
