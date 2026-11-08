import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { config } from "../../../config.js";
import { db, type DbTransaction } from "../../../db/db.js";
import { assistantModelCalls } from "../../../db/schema/assistant-meter-schema.js";
import { assistantChatMessages } from "../../../db/schema/assistant-schema.js";
import { logger } from "../../../middleware/logger.js";
import AppError from "../../../utils/appError.js";
import { generateRandomUUID } from "../../../utils/generateUUID.js";
import { ProviderRefusedError, type SessionEvent, type SessionUsage } from "../driver/types.js";
import { ASSISTANT_NOTICE } from "../types.js";
import { costOf, priceFor, rateFor, type MeteredUsage } from "./prices.js";

/**
 * The meter behind the Weekly limit: reserve each step at its worst case
 * before it runs, settle it from the session's usage at the next idle.
 * Reservations take a per-organization advisory lock for the few
 * milliseconds of the check and insert, never across a model call. "Used
 * this week" is settled plus reserved, for the UTC week the database clock
 * is in.
 */

/** At most this many model calls in one turn. */
export const MAX_MODEL_CALLS_PER_TURN = 10;
/** A session's first prompt before any step has settled: the agent's prefix, about 7.8k measured, doubled. */
export const SESSION_PREFIX_TOKENS = 16_000;
const MARGIN_TOKENS = 1_000;
/** The screen's instruction and help index, about 2.5k measured, rounded up. */
const SCREEN_PROMPT_TOKENS = 4_000;
const SCREEN_OUTPUT_RESERVE = 256;
/** How long one spend-limit refusal marks the Assistant unavailable for every organization. */
const PROVIDER_REFUSAL_HOLD_MS = 5 * 60_000;

const calls = assistantModelCalls;

const currentWeek = sql`(date_trunc('week', now() AT TIME ZONE 'UTC'))::date`;

const usedSum = sql<number>`coalesce(sum(case when ${calls.status} = 'settled'
  then ${calls.settledMicroUsd} else ${calls.reservedMicroUsd} end), 0)::float8`;

/** A conservative token count for text we append to a prompt: three UTF-8 bytes a token. */
export const textTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 3);

export const meteredUsage = (usage: SessionUsage): MeteredUsage => ({
  inputTokens: usage.input_tokens,
  cacheWrite5mTokens: usage.cache_creation.ephemeral_5m_input_tokens,
  cacheWrite1hTokens: usage.cache_creation.ephemeral_1h_input_tokens,
  cacheReadTokens: usage.cache_read_input_tokens,
  outputTokens: usage.output_tokens,
});

/** What a session has used so far at list price, the figure its spend ceiling is checked against. */
export const sessionCost = (usage: SessionUsage): number =>
  costOf(priceFor(config.assistant.model, new Date()), meteredUsage(usage));

/**
 * One step's worst case: the previous prompt, its output, the appended text
 * and a margin all written to the cache, plus the output allowance.
 */
export const worstCase = (args: {
  model: string;
  promptTokens: number;
  outputTokens: number;
}): number => {
  const price = priceFor(args.model, new Date());
  const prompt = args.promptTokens + MARGIN_TOKENS;
  return Math.ceil(
    (prompt * rateFor(price, prompt, "cacheWrite5m") +
      args.outputTokens * rateFor(price, prompt, "output")) /
      1_000_000
  );
};

const mainWorstCase = (previousTokens: number, appendedText: string) =>
  worstCase({
    model: config.assistant.model,
    promptTokens: Math.max(previousTokens, SESSION_PREFIX_TOKENS) + textTokens(appendedText),
    outputTokens: config.assistant.stepOutputReserve,
  });

export type WeeklyUsage = {
  usedMicroUsd: number;
  limitMicroUsd: number;
  /** Next Monday 00:00 UTC by the database clock. */
  resetsAt: Date;
  /** Even the smallest step would pass the limit, so no turn can start. */
  reached: boolean;
};

const nextReset = async (client: DbTransaction | typeof db): Promise<Date> => {
  const { rows } = await client.execute<{ resets_at: string | Date }>(
    sql`select (date_trunc('week', now() AT TIME ZONE 'UTC') + interval '7 days') AT TIME ZONE 'UTC' as resets_at`
  );
  return new Date(rows[0]!.resets_at);
};

/** This week's Usage per organization; organizations with no row read as zero. */
export const readWeeklyUsage = async (
  organizationIds: string[]
): Promise<Map<string, WeeklyUsage>> => {
  const result = new Map<string, WeeklyUsage>();
  if (organizationIds.length === 0) return result;
  const rows = await db
    .select({ organizationId: calls.organizationId, used: usedSum.mapWith(Number) })
    .from(calls)
    .where(and(inArray(calls.organizationId, organizationIds), eq(calls.weekStart, currentWeek)))
    .groupBy(calls.organizationId);
  const resetsAt = await nextReset(db);
  const limit = config.assistant.weeklyLimitMicroUsd;
  const smallestStep = mainWorstCase(0, "");
  for (const organizationId of organizationIds) {
    const used = rows.find((row) => row.organizationId === organizationId)?.used ?? 0;
    result.set(organizationId, {
      usedMicroUsd: used,
      limitMicroUsd: limit,
      resetsAt,
      reached: used + smallestStep > limit,
    });
  }
  return result;
};

export const WEEKLY_LIMIT_REACHED = ASSISTANT_NOTICE.WEEKLY_LIMIT;

export const weeklyLimitReached = (resetsAt: Date) =>
  new AppError({
    message: "The organization reached this week's Assistant limit",
    code: 429,
    publicContext: { code: WEEKLY_LIMIT_REACHED, resetsAt: resetsAt.toISOString() },
  });

const lockOrganization = async (tx: DbTransaction, organizationId: string) => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`assistant-meter:${organizationId}`}, 0))`
  );
};

const usedThisWeek = async (tx: DbTransaction, organizationId: string): Promise<number> => {
  const [row] = await tx
    .select({ used: usedSum.mapWith(Number) })
    .from(calls)
    .where(and(eq(calls.organizationId, organizationId), eq(calls.weekStart, currentWeek)));
  return row?.used ?? 0;
};

/** The previous step's prompt and output, from the session's latest settled step. */
const previousContext = async (tx: DbTransaction, sessionId: string | null): Promise<number> => {
  if (!sessionId) return 0;
  const [row] = await tx
    .select()
    .from(calls)
    .where(
      and(eq(calls.sessionId, sessionId), eq(calls.purpose, "main"), eq(calls.status, "settled"))
    )
    .orderBy(desc(calls.settledAt))
    .limit(1);
  if (!row) return 0;
  return (
    (row.inputTokens ?? 0) +
    (row.cacheWrite5mTokens ?? 0) +
    (row.cacheWrite1hTokens ?? 0) +
    (row.cacheReadTokens ?? 0) +
    (row.outputTokens ?? 0)
  );
};

type StepOwner = {
  organizationId: string;
  userId: string;
  chatId: string | null;
  sessionId: string | null;
};

export type Reservation = { id: string; reservedMicroUsd: number };

const insertReservation = async (
  tx: DbTransaction,
  owner: StepOwner,
  step: {
    purpose: "main" | "screen";
    model: string;
    reservedMicroUsd: number;
    triggerEventId?: string;
  }
): Promise<Reservation> => {
  const id = generateRandomUUID();
  await tx.insert(calls).values({
    id,
    organizationId: owner.organizationId,
    userId: owner.userId,
    chatId: owner.chatId,
    sessionId: owner.sessionId,
    triggerEventId: step.triggerEventId ?? null,
    purpose: step.purpose,
    modelId: step.model,
    priceVersion: priceFor(step.model, new Date()).version,
    reservedMicroUsd: step.reservedMicroUsd,
  });
  return { id, reservedMicroUsd: step.reservedMicroUsd };
};

const limitReachedLog = (organizationId: string, purpose: string) =>
  logger.info("assistant.weekly_limit_reached", { organizationId, purpose });

/**
 * Reserves the step that sends a user message, or throws 429 with the reset
 * when its worst case would pass the Weekly limit. A refusal writes nothing.
 */
export const reserveTurnStart = async (
  owner: StepOwner & { appendedText: string }
): Promise<Reservation> => {
  const reservation = await db.transaction(async (tx) => {
    await lockOrganization(tx, owner.organizationId);
    const worst = mainWorstCase(await previousContext(tx, owner.sessionId), owner.appendedText);
    const used = await usedThisWeek(tx, owner.organizationId);
    if (used + worst > config.assistant.weeklyLimitMicroUsd) return null;
    return insertReservation(tx, owner, {
      purpose: "main",
      model: config.assistant.model,
      reservedMicroUsd: worst,
    });
  });
  if (reservation) return reservation;
  limitReachedLog(owner.organizationId, "main");
  throw weeklyLimitReached(await nextReset(db));
};

export type ToolRound =
  | { kind: "reserved"; reservation: Reservation }
  | { kind: "joined" }
  | { kind: "refused"; code: string };

/**
 * Reserves the step that sends a round of tool results, claimed by the idle
 * event that asked for them, so concurrent advances of one turn reserve it
 * once. A refusal (Weekly limit, or the turn's 10 model calls) is claimed the
 * same way: its fixed notice in the display record, keyed on that idle.
 */
export const reserveToolRound = async (
  owner: StepOwner & {
    sessionId: string;
    chatId: string;
    triggerEventId: string;
    appendedText: string;
    modelCallsThisTurn: number;
  }
): Promise<ToolRound> => {
  const round = await db.transaction(async (tx): Promise<ToolRound> => {
    await lockOrganization(tx, owner.organizationId);
    const [claimed] = await tx
      .select({ id: calls.id })
      .from(calls)
      .where(
        and(eq(calls.sessionId, owner.sessionId), eq(calls.triggerEventId, owner.triggerEventId))
      )
      .limit(1);
    if (claimed) return { kind: "joined" };
    const [refused] = await tx
      .select({ code: assistantChatMessages.code })
      .from(assistantChatMessages)
      .where(
        and(
          eq(assistantChatMessages.chatId, owner.chatId),
          eq(assistantChatMessages.eventId, owner.triggerEventId),
          eq(assistantChatMessages.kind, "notice")
        )
      )
      .limit(1);
    if (refused?.code) return { kind: "refused", code: refused.code };

    let code: string | null = null;
    let worst = 0;
    if (owner.modelCallsThisTurn >= MAX_MODEL_CALLS_PER_TURN) {
      code = ASSISTANT_NOTICE.STEP_LIMIT;
    } else {
      worst = mainWorstCase(await previousContext(tx, owner.sessionId), owner.appendedText);
      const used = await usedThisWeek(tx, owner.organizationId);
      if (used + worst > config.assistant.weeklyLimitMicroUsd) code = ASSISTANT_NOTICE.WEEKLY_LIMIT;
    }
    if (code) {
      await tx
        .insert(assistantChatMessages)
        .values({
          id: generateRandomUUID(),
          chatId: owner.chatId,
          kind: "notice",
          code,
          eventId: owner.triggerEventId,
        })
        .onConflictDoNothing();
      return { kind: "refused", code };
    }
    const reservation = await insertReservation(tx, owner, {
      purpose: "main",
      model: config.assistant.model,
      reservedMicroUsd: worst,
      triggerEventId: owner.triggerEventId,
    });
    return { kind: "reserved", reservation };
  });
  if (round.kind === "refused" && round.code === ASSISTANT_NOTICE.WEEKLY_LIMIT) {
    limitReachedLog(owner.organizationId, "main");
  }
  return round;
};

/** Records the first event a reserved step sent, which settlement matches against the idles. */
export const attachStepEvent = async (
  reservationId: string,
  sent: { sessionId: string; eventId: string }
): Promise<void> => {
  await db
    .update(calls)
    .set({ sessionId: sent.sessionId, eventId: sent.eventId })
    .where(and(eq(calls.id, reservationId), sql`${calls.eventId} is null`));
};

/** Drops a reservation whose step never reached the model: a failed send or a provider refusal. */
export const voidReservation = async (reservationId: string): Promise<void> => {
  await db.delete(calls).where(and(eq(calls.id, reservationId), eq(calls.status, "reserved")));
};

const isIdle = (event: SessionEvent) =>
  event.type === "session.status_idle" || event.type === "session.status_terminated";

const minus = (a: MeteredUsage, b: MeteredUsage): MeteredUsage => ({
  inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
  cacheWrite5mTokens: Math.max(0, a.cacheWrite5mTokens - b.cacheWrite5mTokens),
  cacheWrite1hTokens: Math.max(0, a.cacheWrite1hTokens - b.cacheWrite1hTokens),
  cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
  outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
});

const tokensOf = (usage: MeteredUsage) => ({
  inputTokens: usage.inputTokens,
  cacheWrite5mTokens: usage.cacheWrite5mTokens,
  cacheWrite1hTokens: usage.cacheWrite1hTokens,
  cacheReadTokens: usage.cacheReadTokens,
  outputTokens: usage.outputTokens,
});

/**
 * Settles the turn's reserved steps that have reached an idle, from the
 * session's cumulative usage: whatever the session used beyond its settled
 * rows goes on the latest of them. `events` is the turn's listing and must
 * be read before `usage`, so the usage covers every step the listing shows
 * ended. A step that never reaches an idle stays charged at its reservation.
 */
export const settleSteps = async (args: {
  organizationId: string;
  sessionId: string;
  startEventId: string;
  events: SessionEvent[];
  /** Read only when a step is due, so most advances cost no extra API call. */
  usage: () => Promise<SessionUsage>;
}): Promise<void> => {
  const lastIdle = args.events.findLast(isIdle);
  if (!lastIdle) return;
  const idleIndex = args.events.indexOf(lastIdle);
  const ended = (eventId: string) => {
    if (eventId === args.startEventId) return true;
    const index = args.events.findIndex((event) => event.id === eventId);
    return index !== -1 && index < idleIndex;
  };
  const open = await db
    .select({ id: calls.id, eventId: calls.eventId })
    .from(calls)
    .where(
      and(
        eq(calls.sessionId, args.sessionId),
        eq(calls.purpose, "main"),
        eq(calls.status, "reserved"),
        isNotNull(calls.eventId)
      )
    );
  const eligible = open.filter((row) => ended(row.eventId!)).map((row) => row.id);
  if (eligible.length === 0) return;

  const stopReason = lastIdle.type === "session.status_idle" ? lastIdle.stop_reason.type : null;
  const usage = await args.usage();
  const settled = await db.transaction(async (tx) => {
    await lockOrganization(tx, args.organizationId);
    const rows = await tx
      .select()
      .from(calls)
      .where(and(inArray(calls.id, eligible), eq(calls.status, "reserved")))
      .orderBy(asc(calls.createdAt));
    if (rows.length === 0) return null;
    const [sum] = await tx
      .select({
        inputTokens: sql<number>`coalesce(sum(${calls.inputTokens}), 0)::int`,
        cacheWrite5mTokens: sql<number>`coalesce(sum(${calls.cacheWrite5mTokens}), 0)::int`,
        cacheWrite1hTokens: sql<number>`coalesce(sum(${calls.cacheWrite1hTokens}), 0)::int`,
        cacheReadTokens: sql<number>`coalesce(sum(${calls.cacheReadTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${calls.outputTokens}), 0)::int`,
      })
      .from(calls)
      .where(
        and(
          eq(calls.sessionId, args.sessionId),
          eq(calls.purpose, "main"),
          eq(calls.status, "settled")
        )
      );
    const delta = minus(meteredUsage(usage), sum!);
    const zero = minus(delta, delta);
    let cost = 0;
    for (const [index, row] of rows.entries()) {
      const usage = index === rows.length - 1 ? delta : zero;
      const rowCost = costOf(priceFor(row.modelId, row.createdAt), usage);
      cost += rowCost;
      await tx
        .update(calls)
        .set({
          status: "settled",
          settledMicroUsd: rowCost,
          ...tokensOf(usage),
          stopReason,
          settledAt: new Date(),
        })
        .where(eq(calls.id, row.id));
    }
    return { cost };
  });
  if (settled) {
    logger.info("assistant.cost_usd", {
      organizationId: args.organizationId,
      purpose: "main",
      microUsd: settled.cost,
    });
  }
};

let providerRefusedAt: number | null = null;

/** Anthropic refused for its spend limit or credits: every organization sees the Assistant unavailable for a while. */
export const noteProviderRefused = (operation: string): void => {
  providerRefusedAt = Date.now();
  logger.error("assistant.provider_refused", { operation });
};

export const providerRefusedRecently = (): boolean =>
  providerRefusedAt !== null && Date.now() - providerRefusedAt < PROVIDER_REFUSAL_HOLD_MS;

/** Tests only. */
export const clearProviderRefusal = (): void => {
  providerRefusedAt = null;
};

export const providerUnavailable = () =>
  new AppError({
    message: "The Assistant is unavailable right now",
    code: 503,
    publicContext: { code: ASSISTANT_NOTICE.UNAVAILABLE },
  });

/** A refusal by the meter, which a caller must pass on rather than read as a failed call. */
export const isMeterRefusal = (error: unknown): boolean => {
  if (!(error instanceof AppError)) return false;
  const code = error.errors[0]?.publicContext.code;
  return code === WEEKLY_LIMIT_REACHED || code === ASSISTANT_NOTICE.UNAVAILABLE;
};

/**
 * One screen call as a metered step: reserved at its worst case (the screen's
 * instruction and index, `promptText`, a margin, and its output), refused with
 * 429 at the Weekly limit, settled from the call's own usage. A provider
 * refusal charges nothing and answers 503; any other failure, a timeout
 * included, stays charged at the reservation.
 */
export const meterScreen = async <T extends { usage: SessionUsage }>(
  owner: { organizationId: string; userId: string; chatId: string | null; promptText: string },
  run: () => Promise<T>
): Promise<T> => {
  if (providerRefusedRecently()) throw providerUnavailable();
  const model = config.assistant.screenModel;
  const worst = worstCase({
    model,
    promptTokens: SCREEN_PROMPT_TOKENS + textTokens(owner.promptText),
    outputTokens: SCREEN_OUTPUT_RESERVE,
  });
  const reservation = await db.transaction(async (tx) => {
    await lockOrganization(tx, owner.organizationId);
    const used = await usedThisWeek(tx, owner.organizationId);
    if (used + worst > config.assistant.weeklyLimitMicroUsd) return null;
    return insertReservation(
      tx,
      { ...owner, sessionId: null },
      { purpose: "screen", model, reservedMicroUsd: worst }
    );
  });
  if (!reservation) {
    limitReachedLog(owner.organizationId, "screen");
    throw weeklyLimitReached(await nextReset(db));
  }

  let answer: T;
  try {
    answer = await run();
  } catch (error) {
    if (error instanceof ProviderRefusedError) {
      await voidReservation(reservation.id);
      noteProviderRefused("screen");
      throw providerUnavailable();
    }
    throw error;
  }
  const usage = meteredUsage(answer.usage);
  const cost = costOf(priceFor(model, new Date()), usage);
  await db
    .update(calls)
    .set({ status: "settled", settledMicroUsd: cost, ...tokensOf(usage), settledAt: new Date() })
    .where(eq(calls.id, reservation.id));
  logger.info("assistant.cost_usd", {
    organizationId: owner.organizationId,
    purpose: "screen",
    microUsd: cost,
  });
  return answer;
};
