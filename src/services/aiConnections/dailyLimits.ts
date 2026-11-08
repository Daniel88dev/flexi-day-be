import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import {
  aiConnectionDailyCalls,
  aiConnectionMemberDailyCalls,
} from "../../db/schema/ai-connection-usage-schema.js";
import { logger } from "../../middleware/logger.js";
import { planForOrganization } from "../billing/guards.js";
import type { Entitlements } from "../billing/entitlements.js";

/** `tools/call` requests per member per organization and UTC day. */
export const MEMBER_DAILY_LIMIT = 1000;

/** `tools/call` requests per organization and UTC day: Pro 5,000, Enterprise and Custom 20,000. */
export const dailyAiConnectionLimit = (plan: Entitlements["plan"]): number => {
  if (plan === "ENTERPRISE" || plan === "CUSTOM") return 20_000;
  if (plan === "PRO") return 5_000;
  return 0;
};

export type DailyLimitName = "organization" | "member";

export type DailyCallCount =
  { counted: true } | { counted: false; limit: DailyLimitName; max: number; resetsAt: Date };

const today = sql`(date_trunc('day', now() AT TIME ZONE 'UTC'))::date`;

/** Midnight UTC after `now`, when both daily limits start over. */
export const nextUtcMidnight = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

class Refused extends Error {
  constructor(readonly limit: DailyLimitName) {
    super(limit);
  }
}

/**
 * Counts one `tools/call` against the daily AI connection limit and the member
 * daily limit, or refuses it and counts nothing. Each counter row only rises
 * while under its limit, so concurrent calls never pass it.
 */
export const countAiConnectionCall = async (args: {
  organizationId: string;
  userId: string;
}): Promise<DailyCallCount> => {
  const max = dailyAiConnectionLimit(await planForOrganization(args.organizationId));
  try {
    await db.transaction(async (tx) => {
      const organization = await tx
        .insert(aiConnectionDailyCalls)
        .values({ organizationId: args.organizationId, calls: 1 })
        .onConflictDoUpdate({
          target: [aiConnectionDailyCalls.organizationId, aiConnectionDailyCalls.day],
          set: { calls: sql`${aiConnectionDailyCalls.calls} + 1` },
          setWhere: lt(aiConnectionDailyCalls.calls, max),
        })
        .returning({ calls: aiConnectionDailyCalls.calls });
      if (organization.length === 0) throw new Refused("organization");

      const member = await tx
        .insert(aiConnectionMemberDailyCalls)
        .values({ organizationId: args.organizationId, userId: args.userId, calls: 1 })
        .onConflictDoUpdate({
          target: [
            aiConnectionMemberDailyCalls.organizationId,
            aiConnectionMemberDailyCalls.day,
            aiConnectionMemberDailyCalls.userId,
          ],
          set: { calls: sql`${aiConnectionMemberDailyCalls.calls} + 1` },
          setWhere: lt(aiConnectionMemberDailyCalls.calls, MEMBER_DAILY_LIMIT),
        })
        .returning({ calls: aiConnectionMemberDailyCalls.calls });
      if (member.length === 0) throw new Refused("member");
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    if (error.limit === "organization") await markOrganizationLimitReached(args.organizationId);
    return {
      counted: false,
      limit: error.limit,
      max: error.limit === "organization" ? max : MEMBER_DAILY_LIMIT,
      resetsAt: nextUtcMidnight(new Date()),
    };
  }
  return { counted: true };
};

/** Stamps the day's first refusal; only that one logs, so the log fires once a day per organization. */
const markOrganizationLimitReached = async (organizationId: string) => {
  const stamped = await db
    .update(aiConnectionDailyCalls)
    .set({ limitReachedAt: sql`now()` })
    .where(
      and(
        eq(aiConnectionDailyCalls.organizationId, organizationId),
        eq(aiConnectionDailyCalls.day, today),
        isNull(aiConnectionDailyCalls.limitReachedAt)
      )
    )
    .returning({ organizationId: aiConnectionDailyCalls.organizationId });
  if (stamped.length > 0) logger.info("mcp.daily_limit_reached", { organizationId });
};
