import { and, eq, sql, type SQL } from "drizzle-orm";
import { config } from "../../config.js";
import { db, type DbTransaction } from "../../db/db.js";
import { assistantModelCalls } from "../../db/schema/assistant-meter-schema.js";
import { assistantRejectedTurns } from "../../db/schema/assistant-schema.js";
import { aiConnectionMemberDailyCalls } from "../../db/schema/ai-connection-usage-schema.js";
import { aiUsageUserWeeks } from "../../db/schema/ai-usage-weeks-schema.js";
import { smallestStepMicroUsd, usedAmount } from "../assistant/meter/meter.js";

/** Ledger rows and daily AI connection counters are kept this long. */
export const LEDGER_DAYS = 90;
/** Per-person weekly totals and rejected turns are kept this long; organization totals stay. */
export const PER_PERSON_DAYS = 180;

const LOCK_KEY = "ai-usage-retention";

/**
 * True while every ledger row and daily counter of the week is still kept, so
 * the week reads from them rather than from its rollup.
 */
export const weekInLedger = (weekStart: SQL | string, now: SQL = sql`now()`) =>
  sql`(${weekStart}::date::timestamp AT TIME ZONE 'UTC') >= (${now} - ${`${LEDGER_DAYS} days`}::interval)`;

/** First day of the per-person retention, the UTC date `PER_PERSON_DAYS` before `now`. */
export const perPersonFrom = (now: SQL = sql`now()`) =>
  sql`((${now} AT TIME ZONE 'UTC')::date - ${PER_PERSON_DAYS}::int)`;

const weekOf = (day: SQL) => sql`(date_trunc('week', ${day}::timestamp))::date`;

export type RetentionResult = {
  skipped: boolean;
  rolledWeeks: number;
  ledgerRows: number;
  counterRows: number;
  rejectedTurns: number;
  foldedRows: number;
};

/**
 * Rolls every finished week whose source rows are all still kept (and any
 * finished week never rolled) into per-person and organization totals,
 * recomputed from scratch so a late settle or an Erase stays consistent.
 */
const rollFinishedWeeks = async (tx: DbTransaction, now: SQL): Promise<number> => {
  const currentWeek = sql`(date_trunc('week', ${now} AT TIME ZONE 'UTC'))::date`;
  await tx.execute(sql`
    create temp table ai_usage_roll_targets on commit drop as
    select distinct s.organization_id, s.week_start
    from (
      select organization_id, week_start from assistant_model_calls
      union select organization_id, ${weekOf(sql`day`)} from ai_connection_daily_calls
      union select organization_id, ${weekOf(sql`day`)} from ai_connection_member_daily_calls
    ) s
    left join ai_usage_organization_weeks o
      on o.organization_id = s.organization_id and o.week_start = s.week_start
    where s.week_start < ${currentWeek}
      and (${weekInLedger(sql`s.week_start`, now)} or o.organization_id is null)`);

  const calls = assistantModelCalls;
  const targetLedger = sql`(
    select ${calls.organizationId} as organization_id, ${calls.userId} as user_id,
      ${calls.weekStart} as week_start, ${calls.createdAt} as created_at, ${calls.id} as id,
      ${usedAmount} as used
    from ${calls}
    join ai_usage_roll_targets t
      on t.organization_id = ${calls.organizationId} and t.week_start = ${calls.weekStart}
  )`;

  await tx.execute(sql`
    delete from ai_usage_user_weeks u using ai_usage_roll_targets t
    where u.organization_id = t.organization_id and u.week_start = t.week_start`);

  await tx.execute(sql`
    insert into ai_usage_user_weeks
      (id, organization_id, user_id, week_start, used_micro_usd, ai_connection_calls)
    select gen_random_uuid()::text, organization_id, user_id, week_start, sum(used), sum(calls)
    from (
      select organization_id, user_id, week_start, used, 0 as calls from ${targetLedger} l
      union all
      select m.organization_id, m.user_id, ${weekOf(sql`m.day`)}, 0, m.calls
      from ai_connection_member_daily_calls m
      join ai_usage_roll_targets t
        on t.organization_id = m.organization_id and t.week_start = ${weekOf(sql`m.day`)}
    ) rows
    group by organization_id, user_id, week_start`);

  const threshold = config.assistant.weeklyLimitMicroUsd - smallestStepMicroUsd();
  const { rows } = await tx.execute<{ count: number }>(sql`
    with running as (
      select organization_id, week_start, created_at,
        sum(used) over (partition by organization_id, week_start order by created_at, id
          rows between unbounded preceding and current row) as total
      from ${targetLedger} l
    ), spend as (
      select organization_id, week_start, max(total) as used,
        min(created_at) filter (where total > ${threshold}::float8) as reached_at
      from running group by organization_id, week_start
    ), connection_calls as (
      select d.organization_id, ${weekOf(sql`d.day`)} as week_start, sum(d.calls) as calls
      from ai_connection_daily_calls d
      join ai_usage_roll_targets t
        on t.organization_id = d.organization_id and t.week_start = ${weekOf(sql`d.day`)}
      group by 1, 2
    ), written as (
      insert into ai_usage_organization_weeks
        (organization_id, week_start, used_micro_usd, limit_reached_at, ai_connection_calls)
      select t.organization_id, t.week_start, coalesce(s.used, 0), s.reached_at,
        coalesce(k.calls, 0)
      from ai_usage_roll_targets t
      left join spend s on s.organization_id = t.organization_id and s.week_start = t.week_start
      left join connection_calls k
        on k.organization_id = t.organization_id and k.week_start = t.week_start
      on conflict (organization_id, week_start) do update set
        used_micro_usd = excluded.used_micro_usd,
        limit_reached_at = excluded.limit_reached_at,
        ai_connection_calls = excluded.ai_connection_calls
      returning 1
    )
    select count(*)::int as count from written`);
  return Number(rows[0]?.count ?? 0);
};

const deleteCount = async (tx: DbTransaction, statement: SQL): Promise<number> => {
  const result = await tx.execute(statement);
  return result.rowCount ?? 0;
};

/**
 * The nightly retention of AI usage: roll finished weeks up, delete ledger
 * rows and daily counters after {@link LEDGER_DAYS}, then fold per-person
 * totals and rejected turns after {@link PER_PERSON_DAYS} into the
 * organization totals, which stay. One instance at a time; another skips.
 */
export const retainAiUsage = async (at = new Date()): Promise<RetentionResult> =>
  db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0)) as locked`
    );
    if (!rows[0]?.locked) {
      return {
        skipped: true,
        rolledWeeks: 0,
        ledgerRows: 0,
        counterRows: 0,
        rejectedTurns: 0,
        foldedRows: 0,
      };
    }

    const now = sql`${at.toISOString()}::timestamptz`;
    const ledgerCutoff = sql`(${now} - ${`${LEDGER_DAYS} days`}::interval)`;
    const ledgerFirstDay = sql`(${ledgerCutoff} AT TIME ZONE 'UTC')::date`;

    const rolledWeeks = await rollFinishedWeeks(tx, now);

    const ledgerRows = await deleteCount(
      tx,
      sql`delete from ${assistantModelCalls} where ${assistantModelCalls.createdAt} < ${ledgerCutoff}`
    );
    const counterRows =
      (await deleteCount(
        tx,
        sql`delete from ai_connection_daily_calls where day < ${ledgerFirstDay}`
      )) +
      (await deleteCount(
        tx,
        sql`delete from ai_connection_member_daily_calls where day < ${ledgerFirstDay}`
      ));
    const rejectedTurns = await deleteCount(
      tx,
      sql`delete from ${assistantRejectedTurns}
        where ${assistantRejectedTurns.createdAt} < ${now} - ${`${PER_PERSON_DAYS} days`}::interval`
    );

    await tx.execute(sql`
      insert into ai_usage_organization_weeks
        (organization_id, week_start, used_micro_usd, ai_connection_calls)
      select organization_id, week_start, sum(used_micro_usd), sum(ai_connection_calls)
      from ai_usage_user_weeks where week_start < ${perPersonFrom(now)}
      group by organization_id, week_start
      on conflict (organization_id, week_start) do nothing`);
    const foldedRows = await deleteCount(
      tx,
      sql`delete from ai_usage_user_weeks where week_start < ${perPersonFrom(now)}`
    );

    return { skipped: false, rolledWeeks, ledgerRows, counterRows, rejectedTurns, foldedRows };
  });

/**
 * Erase: the organization's Usage of the person keeps its cost and loses the
 * person. Ledger rows and weekly totals drop the user; the per-person daily
 * AI connection counts and rejected turns go, as the organization's own
 * counts already hold them.
 */
export const eraseAiUsage = async (
  { organizationId, userId }: { organizationId: string; userId: string },
  tx: DbTransaction
): Promise<void> => {
  await tx
    .update(assistantModelCalls)
    .set({ userId: null })
    .where(
      and(
        eq(assistantModelCalls.organizationId, organizationId),
        eq(assistantModelCalls.userId, userId)
      )
    );
  await tx
    .update(aiUsageUserWeeks)
    .set({ userId: null })
    .where(
      and(eq(aiUsageUserWeeks.organizationId, organizationId), eq(aiUsageUserWeeks.userId, userId))
    );
  await tx
    .delete(aiConnectionMemberDailyCalls)
    .where(
      and(
        eq(aiConnectionMemberDailyCalls.organizationId, organizationId),
        eq(aiConnectionMemberDailyCalls.userId, userId)
      )
    );
  await tx
    .delete(assistantRejectedTurns)
    .where(
      and(
        eq(assistantRejectedTurns.organizationId, organizationId),
        eq(assistantRejectedTurns.userId, userId)
      )
    );
};
