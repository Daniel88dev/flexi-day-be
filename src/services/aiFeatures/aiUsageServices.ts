import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { assistantModelCalls } from "../../db/schema/assistant-meter-schema.js";
import { assistantRejectedTurns } from "../../db/schema/assistant-schema.js";
import { aiConnectionMemberDailyCalls } from "../../db/schema/ai-connection-usage-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { isAiConnectionsPlan, isAssistantPlan, planForOrganization } from "../billing/guards.js";
import {
  readWeeklyUsage,
  smallestStepMicroUsd,
  usedAmount,
  usedSum,
} from "../assistant/meter/meter.js";
import { countRejectedTurnsThisWeek } from "../assistant/screen/rejectedTurns.js";
import { dailyAiConnectionLimit, MEMBER_DAILY_LIMIT } from "../aiConnections/dailyLimits.js";
import {
  listOrganizationConnections,
  type OrganizationConnection,
} from "../aiConnections/grants.js";
import { DELETED_ACCOUNT_NAME, personName } from "../person/personName.js";
import { isAiFeatureAvailable } from "./aiFeatureServices.js";

/** Per-person usage is kept this long; older weeks show the organization total only. */
export const PER_PERSON_DAYS = 180;
const PAST_WEEKS = 52;
const CALL_DAYS = 14;

const calls = assistantModelCalls;
const currentWeek = sql`(date_trunc('week', now() AT TIME ZONE 'UTC'))::date`;
const today = sql`(date_trunc('day', now() AT TIME ZONE 'UTC'))::date`;

const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));
const toDateOrNull = (value: string | Date | null): Date | null =>
  value === null ? null : toDate(value);

export type UsageWeek = {
  weekStart: string;
  usedMicroUsd: number;
  /** When used plus the smallest first step first passed the limit; `null` if it never did. */
  limitReachedAt: Date | null;
  /** The week opens to a per-person split. */
  perPerson: boolean;
};

/**
 * Every week of the organization's ledger in the last year, newest first,
 * the current one included. A week counts as limit-reached by the rule
 * `readWeeklyUsage` uses for `reached`, and the moment is the ledger row whose
 * running total crossed it.
 */
const readWeeks = async (organizationId: string, limitMicroUsd: number): Promise<UsageWeek[]> => {
  const threshold = limitMicroUsd - smallestStepMicroUsd();
  const { rows } = await db.execute<{
    week_start: string;
    used: number;
    reached_at: string | Date | null;
    per_person: boolean;
  }>(sql`
    with ledger as (
      select ${calls.weekStart} as week_start, ${calls.createdAt} as created_at,
        ${calls.id} as id, ${usedAmount} as used
      from ${calls}
      where ${calls.organizationId} = ${organizationId}
        and ${calls.weekStart} >= ${currentWeek} - ${PAST_WEEKS * 7}::int
    ), running as (
      select week_start, created_at,
        sum(used) over (partition by week_start order by created_at, id
          rows between unbounded preceding and current row) as total
      from ledger
    )
    select week_start::text as week_start, max(total)::float8 as used,
      min(created_at) filter (where total > ${threshold}::float8) as reached_at,
      week_start >= ${currentWeek} - ${PER_PERSON_DAYS}::int as per_person
    from running
    group by week_start
    order by week_start desc`);
  return rows.map((row) => ({
    weekStart: row.week_start,
    usedMicroUsd: Number(row.used),
    limitReachedAt: toDateOrNull(row.reached_at),
    perPerson: row.per_person,
  }));
};

export type CallDay = { day: string; calls: number; limitReachedAt: Date | null };

/** The last 14 UTC days of AI connection calls, oldest first, days with none as zero. */
const readCallDays = async (organizationId: string) => {
  const { rows } = await db.execute<{
    day: string;
    calls: number;
    limit_reached_at: string | Date | null;
  }>(sql`
    select d::date::text as day, coalesce(c.calls, 0)::int as calls, c.limit_reached_at
    from generate_series(${today} - ${CALL_DAYS - 1}::int, ${today}, interval '1 day') d
    left join ai_connection_daily_calls c
      on c.organization_id = ${organizationId} and c.day = d::date
    order by d`);
  const { rows: reset } = await db.execute<{ resets_at: string | Date }>(
    sql`select (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' as resets_at`
  );
  return {
    days: rows.map((row): CallDay => ({
      day: row.day,
      calls: Number(row.calls),
      limitReachedAt: toDateOrNull(row.limit_reached_at),
    })),
    resetsAt: toDate(reset[0]!.resets_at),
  };
};

/** Names as the organization shows them; a Deleted account with no copy left reads `null`. */
const namesOf = async (organizationId: string, userIds: string[]) => {
  const names = new Map<string, string | null>();
  if (userIds.length === 0) return names;
  const rows = await db
    .select({ id: user.id, name: personName(user, { organizationId }) })
    .from(user)
    .where(inArray(user.id, userIds));
  for (const row of rows) {
    names.set(row.id, row.name === DELETED_ACCOUNT_NAME ? null : row.name);
  }
  return names;
};

type PersonKey = string | null;

type SQLDate = SQL | string;

/** Named people by the given order, then every Deleted account. */
const byNameLast =
  <T extends { name: string | null }>(compare: (a: T, b: T) => number) =>
  (a: T, b: T) => {
    if ((a.name === null) !== (b.name === null)) return a.name === null ? 1 : -1;
    return compare(a, b) || (a.name ?? "").localeCompare(b.name ?? "");
  };

const spendByPerson = async (organizationId: string, weekStart: SQLDate) => {
  const rows = await db
    .select({ userId: calls.userId, used: usedSum.mapWith(Number) })
    .from(calls)
    .where(and(eq(calls.organizationId, organizationId), eq(calls.weekStart, weekStart)))
    .groupBy(calls.userId);
  return new Map<PersonKey, number>(rows.map((row) => [row.userId, row.used]));
};

export type UsagePerson = {
  /** `null` for usage whose account was erased. */
  userId: string | null;
  /** `null` shows as "Deleted account". */
  name: string | null;
  assistantMicroUsd: number;
  refusedTurns: number;
  callsToday: number;
  apps: Omit<OrganizationConnection, "userId">[];
};

const readPeople = async (organizationId: string): Promise<UsagePerson[]> => {
  const spend = await spendByPerson(organizationId, currentWeek);
  const refused = await countRejectedTurnsThisWeek(organizationId);
  const callRows = await db
    .select({
      userId: aiConnectionMemberDailyCalls.userId,
      calls: aiConnectionMemberDailyCalls.calls,
    })
    .from(aiConnectionMemberDailyCalls)
    .where(
      and(
        eq(aiConnectionMemberDailyCalls.organizationId, organizationId),
        eq(aiConnectionMemberDailyCalls.day, today)
      )
    );
  const callsToday = new Map(callRows.map((row) => [row.userId, row.calls]));
  const connections = await listOrganizationConnections(organizationId);

  const keys = new Set<PersonKey>([
    ...spend.keys(),
    ...refused.keys(),
    ...callsToday.keys(),
    ...connections.map((connection) => connection.userId),
  ]);
  const names = await namesOf(
    organizationId,
    [...keys].filter((key): key is string => key !== null)
  );

  return [...keys]
    .map((userId): UsagePerson => {
      const turns = userId ? refused.get(userId) : undefined;
      return {
        userId,
        name: userId ? (names.get(userId) ?? null) : null,
        assistantMicroUsd: spend.get(userId) ?? 0,
        refusedTurns: turns ? turns.offTopic + turns.attack : 0,
        callsToday: userId ? (callsToday.get(userId) ?? 0) : 0,
        apps: connections
          .filter((connection) => connection.userId === userId)
          .map(({ userId: _owner, ...app }) => app),
      };
    })
    .sort(
      byNameLast((a, b) => b.assistantMicroUsd - a.assistantMicroUsd || b.callsToday - a.callsToday)
    );
};

/** What the AI usage page shows an owner or org admin of the organization. */
export const readAiUsage = async (organizationId: string) => {
  const [organization] = await db
    .select({
      name: organizations.name,
      assistantEnabled: organizations.assistantEnabled,
      aiConnections: organizations.aiConnections,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const plan = await planForOrganization(organizationId);
  const week = (await readWeeklyUsage([organizationId])).get(organizationId)!;
  const weeks = await readWeeks(organizationId, week.limitMicroUsd);
  const [{ week_start: thisWeek }] = (
    await db.execute<{ week_start: string }>(sql`select ${currentWeek}::text as week_start`)
  ).rows as [{ week_start: string }];
  const callDays = await readCallDays(organizationId);

  return {
    organizationId,
    organizationName: organization!.name,
    assistant: {
      on:
        organization!.assistantEnabled &&
        isAssistantPlan(plan) &&
        isAiFeatureAvailable("assistant", organizationId),
      weekStart: thisWeek,
      usedMicroUsd: week.usedMicroUsd,
      limitMicroUsd: week.limitMicroUsd,
      resetsAt: week.resetsAt,
      reached: week.reached,
      limitReachedAt: weeks.find((row) => row.weekStart === thisWeek)?.limitReachedAt ?? null,
      weeks: weeks.filter((row) => row.weekStart !== thisWeek),
    },
    aiConnections: {
      on:
        organization!.aiConnections !== aiConnectionsLevel.Off &&
        isAiConnectionsPlan(plan) &&
        isAiFeatureAvailable("aiConnections", organizationId),
      dailyLimit: dailyAiConnectionLimit(plan),
      memberDailyLimit: MEMBER_DAILY_LIMIT,
      callsToday: callDays.days.at(-1)?.calls ?? 0,
      resetsAt: callDays.resetsAt,
      days: callDays.days,
    },
    people: await readPeople(organizationId),
  };
};

export type UsageWeekPerson = Pick<
  UsagePerson,
  "userId" | "name" | "assistantMicroUsd" | "refusedTurns"
>;

/**
 * One past week: the organization total, and the per-person split while the
 * week is within the per-person retention, `people: null` after it.
 */
export const readAiUsageWeek = async (organizationId: string, weekStart: string) => {
  const [total] = await db
    .select({
      used: usedSum.mapWith(Number),
      perPerson: sql<boolean>`${weekStart}::date >= ${currentWeek} - ${PER_PERSON_DAYS}::int`,
    })
    .from(calls)
    .where(and(eq(calls.organizationId, organizationId), eq(calls.weekStart, weekStart)));
  if (!total!.perPerson) {
    return { weekStart, usedMicroUsd: total!.used, people: null };
  }

  const spend = await spendByPerson(organizationId, weekStart);
  const from = sql`${weekStart}::date AT TIME ZONE 'UTC'`;
  const until = sql`(${weekStart}::date + 7) AT TIME ZONE 'UTC'`;
  const refusedRows = await db
    .select({ userId: assistantRejectedTurns.userId, count: sql<number>`count(*)::int` })
    .from(assistantRejectedTurns)
    .where(
      and(
        eq(assistantRejectedTurns.organizationId, organizationId),
        gte(assistantRejectedTurns.createdAt, from),
        lt(assistantRejectedTurns.createdAt, until)
      )
    )
    .groupBy(assistantRejectedTurns.userId);
  const refused = new Map<PersonKey, number>(refusedRows.map((row) => [row.userId, row.count]));
  const keys = new Set<PersonKey>([...spend.keys(), ...refused.keys()]);
  const names = await namesOf(
    organizationId,
    [...keys].filter((key): key is string => key !== null)
  );

  const people = [...keys]
    .map((userId): UsageWeekPerson => ({
      userId,
      name: userId ? (names.get(userId) ?? null) : null,
      assistantMicroUsd: spend.get(userId) ?? 0,
      refusedTurns: refused.get(userId) ?? 0,
    }))
    .sort(byNameLast((a, b) => b.assistantMicroUsd - a.assistantMicroUsd));
  return { weekStart, usedMicroUsd: total!.used, people };
};
