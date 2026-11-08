import * as Sentry from "@sentry/node";
import { and, desc, eq, gt, isNotNull, lt, ne } from "drizzle-orm";
import { db } from "../../db/db.js";
import { assistantChatMessages, assistantChats } from "../../db/schema/assistant-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import type { AuthSession } from "../../middleware/authSession.js";
import { logger } from "../../middleware/logger.js";
import type { ToolLanguage } from "../../tools/types.js";
import AppError from "../../utils/appError.js";
import { errorName } from "../../utils/errorName.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertAiEligible } from "../aiFeatures/aiEligibility.js";
import { isAiFeatureAvailable } from "../aiFeatures/aiFeatureServices.js";
import { getUserLanguage } from "../userSettings/userSettingsServices.js";
import { answerAssistantToolCall, runConfirmedWrite } from "./assistantTools.js";
import { getOwnChat, roleIn, type ChatRow } from "./chatServices.js";
import { assistantDriver } from "./driver/index.js";
import {
  isProviderRefusal,
  ProviderRefusedError,
  type AssistantDriver,
  type SessionEvent,
  type SessionInputEvent,
  type SessionUsage,
} from "./driver/types.js";
import {
  attachStepEvent,
  noteProviderRefused,
  providerRefusedRecently,
  providerUnavailable,
  reserveToolRound,
  reserveTurnStart,
  sessionCost,
  settleSteps,
  voidReservation,
  type Reservation,
} from "./meter/meter.js";
import {
  DECLINED_ANSWER,
  NOT_TAKEN_ANSWER,
  dropHeldAnswers,
  heldAnswersOf,
  heldToolUseIds,
  holdAnswers,
  openCardsInRound,
  openCardsOf,
  parkPendingAction,
  pendingActionById,
  presentCard,
  recordCardError,
  settleCard,
  takeRoundAnswers,
  type PendingActionRow,
  type ToolAnswer,
} from "./pendingActions.js";
import { recordRejectedTurn } from "./screen/rejectedTurns.js";
import { screenMessage, screenToolResults } from "./screen/screenServices.js";
import {
  ASSISTANT_NOTICE,
  PENDING_ACTION_SETTLED,
  REJECTED_MESSAGE,
  SCREEN_FAILED,
  TITLE_MAX_LENGTH,
  TOOL_CARD,
  type CardDecision,
} from "./types.js";
import { aiSignal } from "../../utils/aiSignals.js";

/** A turn older than this is taken for dead (a crashed process) and may be reclaimed. */
export const STALE_TURN_MS = 5 * 60_000;
/** The relay gives up on a turn after this long and records an error notice. */
export const TURN_TIMEOUT_MS = 4 * 60_000;

export const TURN_RUNNING = "ASSISTANT_TURN_RUNNING";

/** A tool line whose result was never sent because the meter stopped the turn. */
export const TOOL_STOPPED = "stopped";

const turnRunning = () =>
  new AppError({
    message: "Another answer is still being written",
    code: 409,
    publicContext: { code: TURN_RUNNING },
  });

const isRunningTurnConflict = (error: unknown): boolean => {
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      candidate.code === "23505" &&
      candidate.constraint === "uq_assistant_chats_running_turn_per_user"
    ) {
      return true;
    }
    cursor = candidate.cause;
  }
  return false;
};

/** One running turn per user: frees the user's stale turns, then claims this chat's or answers 409. */
const claimTurn = async (chatId: string, userId: string): Promise<void> => {
  await db
    .update(assistantChats)
    .set({ turnStatus: "idle", turnStartedAt: null })
    .where(
      and(
        eq(assistantChats.userId, userId),
        eq(assistantChats.turnStatus, "running"),
        lt(assistantChats.turnStartedAt, new Date(Date.now() - STALE_TURN_MS))
      )
    );
  try {
    const claimed = await db
      .update(assistantChats)
      .set({ turnStatus: "running", turnStartedAt: new Date(), turnStartEventId: null })
      .where(and(eq(assistantChats.id, chatId), eq(assistantChats.turnStatus, "idle")))
      .returning({ id: assistantChats.id });
    if (claimed.length === 0) throw turnRunning();
  } catch (error) {
    if (isRunningTurnConflict(error)) throw turnRunning();
    throw error;
  }
};

/** Gives a claimed turn back before anything of it was written. */
const unclaimTurn = async (chatId: string): Promise<void> => {
  await db
    .update(assistantChats)
    .set({ turnStatus: "idle", turnStartedAt: null })
    .where(and(eq(assistantChats.id, chatId), eq(assistantChats.turnStatus, "running")));
};

export const releaseTurn = async (chatId: string): Promise<void> => {
  await db
    .update(assistantChats)
    .set({ turnStatus: "idle", turnStartedAt: null, lastMessageAt: new Date() })
    .where(and(eq(assistantChats.id, chatId), eq(assistantChats.turnStatus, "running")));
};

export const isTurnRunning = async (chatId: string): Promise<boolean> => {
  const [row] = await db
    .select({ turnStatus: assistantChats.turnStatus })
    .from(assistantChats)
    .where(eq(assistantChats.id, chatId))
    .limit(1);
  return row?.turnStatus === "running";
};

/** Writes one display row; a row for an event already recorded is skipped. Answers whether it wrote. */
const record = async (
  chatId: string,
  row: Omit<typeof assistantChatMessages.$inferInsert, "id" | "chatId" | "seq">
): Promise<boolean> => {
  const written = await db
    .insert(assistantChatMessages)
    .values({ id: generateRandomUUID(), chatId, ...row })
    .onConflictDoNothing()
    .returning({ id: assistantChatMessages.id });
  return written.length > 0;
};

const toolLanguage = async (userId: string): Promise<ToolLanguage> =>
  (await getUserLanguage(userId)) === appLanguage.Czech ? "cs" : "en";

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Per-user context for the model, sent with the first message and again when
 * the date has changed since the last one. Last in the send, as the API requires.
 */
const contextMessage = async (args: {
  auth: AuthSession;
  chat: ChatRow & { organizationName: string };
  language: ToolLanguage;
  now: Date;
}): Promise<SessionInputEvent> => {
  const role = await roleIn(args.auth.userId, args.chat.organizationId);
  const weekday = args.now.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const text = [
    `Signed-in user: ${args.auth.userName}.`,
    `Role in the organization: ${role}.`,
    `Organization: ${args.chat.organizationName}.`,
    `App language: ${args.language === "cs" ? "Czech" : "English"}.`,
    `Today: ${weekday} ${utcDay(args.now)} (UTC).`,
  ].join(" ");
  return { type: "system.message", content: [{ type: "text", text }] };
};

const screenFailed = () =>
  new AppError({
    message: "Your message couldn't be checked, so it wasn't sent",
    code: 503,
    publicContext: { code: SCREEN_FAILED },
  });

/** A message the screen kept from the session; the chat shows it with the fixed refusal. */
export type RejectedTurn = { rejected: true; chatId: string; code: string };

/** What a send hands from its checks to its stream. */
export type PreparedTurn = {
  rejected?: false;
  auth: AuthSession;
  chatId: string;
  organizationId: string;
  sessionId: string;
  language: ToolLanguage;
  input: SessionInputEvent[];
  driver: AssistantDriver;
  /** The meter's reservation for this send. */
  reservationId: string;
  /** Held tool results the send answers before the message; dropped once sent. */
  carriedToolUseIds: string[];
};

const textOf = (events: SessionInputEvent[]) =>
  events.flatMap((event) => event.content.map((block) => block.text)).join("\n");

const resultEvent = (answer: ToolAnswer): SessionInputEvent => ({
  type: "user.custom_tool_result",
  custom_tool_use_id: answer.toolUseId,
  content: [{ type: "text", text: answer.text }],
  is_error: answer.isError,
});

/**
 * Everything a send checks and writes before its stream opens: the chat is
 * the caller's, the organization still allows the Assistant (403 with the
 * reason otherwise), no other turn of the caller's runs (409), the screen
 * passes the message (a rejected turn is recorded and answered here; a failed
 * screen is 503 with nothing written), the Weekly limit has room for the step
 * (429, nothing written), then the user's text in the display record and the
 * session, created on first use with the reservation as its spend ceiling.
 * An admitted message also carries every tool result the chat still holds,
 * and answers every open card as not taken, ahead of the user's text.
 */
export const prepareTurn = async (args: {
  auth: AuthSession;
  chatId: string;
  text: string;
}): Promise<PreparedTurn | RejectedTurn> => {
  const { auth } = args;
  const chat = await getOwnChat({ userId: auth.userId, chatId: args.chatId });
  await assertAiEligible({
    userId: auth.userId,
    organizationId: chat.organizationId,
    feature: "assistant",
  });
  if (providerRefusedRecently()) throw providerUnavailable();
  await claimTurn(chat.id, auth.userId);

  let reservation: Reservation | null = null;
  let written = false;
  try {
    const driver = assistantDriver();
    const now = new Date();
    const language = await toolLanguage(auth.userId);

    const screen = await screenMessage({
      driver,
      chatId: chat.id,
      organizationId: chat.organizationId,
      userId: auth.userId,
      message: args.text,
      language,
    });
    if (screen.outcome === "failed") throw screenFailed();
    if (screen.outcome === "rejected") {
      await record(chat.id, { kind: "user", text: args.text, code: REJECTED_MESSAGE });
      await record(chat.id, { kind: "notice", code: ASSISTANT_NOTICE.TOPIC_REFUSAL });
      await recordRejectedTurn({
        organizationId: chat.organizationId,
        userId: auth.userId,
        chatId: chat.id,
        reason: screen.reason,
      });
      await db
        .update(assistantChats)
        .set({ title: chat.title ?? args.text.slice(0, TITLE_MAX_LENGTH) })
        .where(eq(assistantChats.id, chat.id));
      await releaseTurn(chat.id);
      return { rejected: true, chatId: chat.id, code: ASSISTANT_NOTICE.TOPIC_REFUSAL };
    }

    const openCards = chat.sessionId ? await openCardsOf(chat.id) : [];
    const carried: ToolAnswer[] = [
      ...(chat.sessionId ? await heldAnswersOf(chat.id) : []),
      ...openCards.map((card) => ({ toolUseId: card.toolUseId, ...NOT_TAKEN_ANSWER })),
    ];
    const input: SessionInputEvent[] = [
      ...carried.map(resultEvent),
      { type: "user.message", content: [{ type: "text", text: args.text }] },
    ];
    if (!chat.sessionId || utcDay(chat.lastMessageAt) !== utcDay(now)) {
      input.push(await contextMessage({ auth, chat, language, now }));
    }
    reservation = await reserveTurnStart({
      organizationId: chat.organizationId,
      userId: auth.userId,
      chatId: chat.id,
      sessionId: chat.sessionId,
      appendedText: textOf(input),
    });

    let sessionId = chat.sessionId;
    if (!sessionId) {
      const created = await driver.createSession({
        chatId: chat.id,
        organizationId: chat.organizationId,
        budgetMicroUsd: reservation.reservedMicroUsd,
      });
      sessionId = created.sessionId;
      await db
        .update(assistantChats)
        .set({ sessionId, agentVersion: created.agentVersion })
        .where(eq(assistantChats.id, chat.id));
    } else {
      const used = sessionCost(await driver.readUsage(sessionId));
      await driver.setBudget(sessionId, used + reservation.reservedMicroUsd);
    }

    written = true;
    for (const card of openCards) {
      await settleCard(card, { status: "not_taken", answer: NOT_TAKEN_ANSWER });
    }
    await record(chat.id, { kind: "user", text: args.text });
    await db
      .update(assistantChats)
      .set({ title: chat.title ?? args.text.slice(0, TITLE_MAX_LENGTH), lastMessageAt: now })
      .where(eq(assistantChats.id, chat.id));

    return {
      auth,
      chatId: chat.id,
      organizationId: chat.organizationId,
      sessionId,
      language,
      input,
      driver,
      reservationId: reservation.id,
      carriedToolUseIds: carried.map((answer) => answer.toolUseId),
    };
  } catch (error) {
    if (reservation) await voidReservation(reservation.id);
    if (written) await releaseTurn(chat.id);
    else await unclaimTurn(chat.id);
    if (error instanceof ProviderRefusedError) {
      noteProviderRefused("prepare_turn");
      throw providerUnavailable();
    }
    throw error;
  }
};

const sighted = new Set<string>();

/**
 * Whether this process sees the event for the first time. `advanceTurn` lists
 * a turn's events again at every idle; events with no display row of their own
 * are logged once through this. Bounded: a restart may log one again.
 */
const firstSighting = (eventId: string): boolean => {
  if (sighted.has(eventId)) return false;
  if (sighted.size >= 1_000) sighted.clear();
  sighted.add(eventId);
  return true;
};

const isTurnEnd = (event: SessionEvent): boolean =>
  (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") ||
  event.type === "session.status_terminated";

type Advance = {
  auth: AuthSession;
  chatId: string;
  organizationId: string;
  sessionId: string;
  startEventId: string;
  language: ToolLanguage;
  driver: AssistantDriver;
};

/**
 * A span named after the step, with the chat id as Sentry's conversation id on
 * it and on everything under it (tool spans, the screen's model call). Ids
 * only: never the chat's text.
 */
const inChat = <T>(
  name: "assistant.relay" | "assistant.advance",
  chatId: string,
  run: () => Promise<T>
): Promise<T> =>
  Sentry.withIsolationScope((scope) => {
    scope.setConversationId(chatId);
    return Sentry.startSpan(
      { name, op: name, attributes: { "gen_ai.conversation.id": chatId } },
      run
    );
  });

/**
 * One idempotent step of a turn: list the turn's events, record the
 * Assistant's text, run the reads it asked for and answer each tool call
 * exactly once (the display row keyed on the tool-use event id is the claim).
 * Answers whether the turn has ended. Safe to run again at any point.
 */
export const advanceTurn = (turn: Advance): Promise<boolean> =>
  inChat("assistant.advance", turn.chatId, () => advance(turn));

const advance = async (turn: Advance): Promise<boolean> => {
  const events = await turn.driver.listEvents(turn.sessionId, { afterId: turn.startEventId });
  const answered = new Set(
    events.flatMap((event) =>
      event.type === "user.custom_tool_result" ? [event.custom_tool_use_id] : []
    )
  );

  for (const event of events) {
    if (event.type === "agent.message") {
      const text = event.content.map((block) => block.text).join("");
      await record(turn.chatId, { kind: "assistant", text, eventId: event.id });
    }
    if (event.type === "session.error" && event.error.retry_status?.type !== "retrying") {
      const refused = isProviderRefusal(event.error);
      const wrote = await record(turn.chatId, {
        kind: "notice",
        code: refused ? ASSISTANT_NOTICE.UNAVAILABLE : ASSISTANT_NOTICE.ERROR,
        eventId: event.id,
      });
      if (wrote) {
        aiSignal("assistant.session_error", {
          chatId: turn.chatId,
          errorType: event.error.type,
          retryStatus: event.error.retry_status?.type ?? "none",
        });
      }
      if (wrote && refused) noteProviderRefused("session");
    }
    if (event.type === "agent.thread_context_compacted" && firstSighting(event.id)) {
      aiSignal("agent.thread_context_compacted", { chatId: turn.chatId });
    }
  }

  const last = events.findLast(
    (event) => event.type === "session.status_idle" || event.type === "session.status_terminated"
  );
  if (!last) return false;

  let usage: SessionUsage | null = null;
  const readUsage = async () => (usage ??= await turn.driver.readUsage(turn.sessionId));
  await settleSteps({
    organizationId: turn.organizationId,
    sessionId: turn.sessionId,
    startEventId: turn.startEventId,
    events,
    usage: readUsage,
  });

  if (isTurnEnd(last)) {
    if (last.type === "session.status_idle" && last.stop_reason.type === "refusal") {
      await record(turn.chatId, {
        kind: "notice",
        code: ASSISTANT_NOTICE.MODEL_REFUSAL,
        eventId: last.id,
      });
    }
    if (last.type === "session.status_idle" && last.stop_reason.type === "budget_reached") {
      const wrote = await record(turn.chatId, {
        kind: "notice",
        code: ASSISTANT_NOTICE.ERROR,
        eventId: last.id,
      });
      if (wrote) aiSignal("session.budget_reached", { chatId: turn.chatId });
    }
    await releaseTurn(turn.chatId);
    return true;
  }
  if (last.type !== "session.status_idle" || last.stop_reason.type !== "requires_action") {
    return false;
  }

  // One round: every tool call of one model response. Reads run at once and
  // writes become cards; the answers wait until no card of the round is open.
  const authorNames = await authorsEarlierInTurn(turn, last.stop_reason.event_ids);
  const answers: ToolAnswer[] = [];
  for (const toolUseId of last.stop_reason.event_ids) {
    if (answered.has(toolUseId)) continue;
    const call = events.find((event) => event.id === toolUseId);
    if (call?.type !== "agent.custom_tool_use") continue;
    const claimed = await record(turn.chatId, {
      kind: "tool",
      toolName: call.name,
      eventId: call.id,
    });
    if (!claimed) continue;
    const step = await answerAssistantToolCall({
      auth: turn.auth,
      organizationId: turn.organizationId,
      language: turn.language,
      name: call.name,
      input: call.input,
    });
    if (step.kind === "card") {
      await parkPendingAction({
        chatId: turn.chatId,
        organizationId: turn.organizationId,
        userId: turn.auth.userId,
        sessionId: turn.sessionId,
        roundEventId: last.id,
        toolUseId: call.id,
        toolName: call.name,
        input: step.input,
        preview: step.preview,
        authorNames,
      });
      await setToolLine(turn.chatId, call.id, { toolOutcome: TOOL_CARD });
      continue;
    }
    await setToolLine(turn.chatId, call.id, {
      toolOutcome: step.outcome,
      textAuthors: step.authors.length > 0 ? step.authors : null,
    });
    answers.push({ toolUseId: call.id, text: step.text, isError: step.isError });
  }
  if (answers.length > 0) {
    // One screen call covers the user text of every read in the response.
    const texts = await screenToolResults({
      driver: turn.driver,
      chatId: turn.chatId,
      organizationId: turn.organizationId,
      userId: turn.auth.userId,
      texts: answers.map((answer) => answer.text),
    });
    await holdAnswers(
      turn.chatId,
      last.id,
      answers.map((answer, index) => ({ ...answer, text: texts[index]! }))
    );
  }
  return advanceRound(turn, { idle: last, events, readUsage });
};

const setToolLine = async (
  chatId: string,
  toolUseId: string,
  values: Pick<typeof assistantChatMessages.$inferInsert, "toolOutcome" | "textAuthors">
) => {
  await db
    .update(assistantChatMessages)
    .set(values)
    .where(
      and(eq(assistantChatMessages.chatId, chatId), eq(assistantChatMessages.eventId, toolUseId))
    );
};

/**
 * Who, other than the user, wrote free text the Assistant read earlier in
 * this turn: since the user's last message, before this round.
 */
const authorsEarlierInTurn = async (turn: Advance, roundToolUseIds: string[]) => {
  const [lastMessage] = await db
    .select({ seq: assistantChatMessages.seq })
    .from(assistantChatMessages)
    .where(
      and(eq(assistantChatMessages.chatId, turn.chatId), eq(assistantChatMessages.kind, "user"))
    )
    .orderBy(desc(assistantChatMessages.seq))
    .limit(1);
  const rows = await db
    .select({
      eventId: assistantChatMessages.eventId,
      textAuthors: assistantChatMessages.textAuthors,
    })
    .from(assistantChatMessages)
    .where(
      and(
        eq(assistantChatMessages.chatId, turn.chatId),
        eq(assistantChatMessages.kind, "tool"),
        isNotNull(assistantChatMessages.textAuthors),
        lastMessage ? gt(assistantChatMessages.seq, lastMessage.seq) : undefined
      )
    )
    .orderBy(assistantChatMessages.seq);
  const names = new Set<string>();
  for (const row of rows) {
    if (row.eventId && roundToolUseIds.includes(row.eventId)) continue;
    for (const author of row.textAuthors ?? []) {
      if (author.userId !== turn.auth.userId) names.add(author.name);
    }
  }
  return [...names];
};

type Round = {
  idle: Extract<SessionEvent, { type: "session.status_idle" }>;
  /** The turn's events, which count its model calls. */
  events: SessionEvent[];
  readUsage: () => Promise<SessionUsage>;
};

const requiresAction = (idle: Round["idle"]): string[] =>
  idle.stop_reason.type === "requires_action" ? idle.stop_reason.event_ids : [];

/**
 * Sends the round once every tool call in it has its answer held. While a
 * card in it is open the turn ends here: the user decides, and the composer
 * is free. Answers whether the turn has ended.
 */
const advanceRound = async (turn: Advance, round: Round): Promise<boolean> => {
  if ((await openCardsInRound(turn.chatId, round.idle.id)) > 0) {
    await releaseTurn(turn.chatId);
    return true;
  }
  const answered = new Set(
    round.events.flatMap((event) =>
      event.type === "user.custom_tool_result" ? [event.custom_tool_use_id] : []
    )
  );
  const held = await heldToolUseIds(turn.chatId, round.idle.id);
  // Another advance is still running one of the calls; it sends the round.
  if (requiresAction(round.idle).some((id) => !answered.has(id) && !held.has(id))) return false;
  return (await sendRound(turn, round)).ended;
};

/**
 * Sends a round's held answers as one metered step, or keeps holding them
 * when the meter refuses it (Weekly limit, 10 model calls): the fixed notice
 * is written and the turn ends, and the user's next admitted message carries
 * them, so no model call runs unreserved and no tool call is left unanswered.
 */
const sendRound = async (
  turn: Advance,
  round: Round
): Promise<{ ended: boolean; firstEventId: string | null }> => {
  const { answers, restore } = await takeRoundAnswers(turn.chatId, round.idle.id);
  if (answers.length === 0) return { ended: false, firstEventId: null };
  const metered = await reserveToolRound({
    organizationId: turn.organizationId,
    userId: turn.auth.userId,
    chatId: turn.chatId,
    sessionId: turn.sessionId,
    triggerEventId: round.idle.id,
    appendedText: answers.map((answer) => answer.text).join("\n"),
    modelCallsThisTurn: round.events.filter((event) => event.type === "span.model_request_start")
      .length,
  });
  if (metered.kind === "refused") {
    await restore(new Set());
    for (const answer of answers) {
      await db
        .update(assistantChatMessages)
        .set({ toolOutcome: TOOL_STOPPED })
        .where(
          and(
            eq(assistantChatMessages.chatId, turn.chatId),
            eq(assistantChatMessages.eventId, answer.toolUseId),
            ne(assistantChatMessages.toolOutcome, TOOL_CARD)
          )
        );
    }
    await releaseTurn(turn.chatId);
    return { ended: true, firstEventId: null };
  }

  const sent = new Set<string>();
  let firstEventId: string | null = null;
  try {
    if (metered.kind === "reserved") {
      const used = sessionCost(await round.readUsage());
      await turn.driver.setBudget(turn.sessionId, used + metered.reservation.reservedMicroUsd);
    }
    for (const answer of answers) {
      const event = await turn.driver.answerToolCall(turn.sessionId, answer.toolUseId, {
        text: answer.text,
        isError: answer.isError,
      });
      sent.add(answer.toolUseId);
      if (firstEventId) continue;
      firstEventId = event.id;
      if (metered.kind === "reserved") {
        await attachStepEvent(metered.reservation.id, {
          sessionId: turn.sessionId,
          eventId: event.id,
        });
      }
    }
  } catch (error) {
    await restore(sent);
    // Nothing reached the session, so no model call ran on this reservation.
    if (metered.kind === "reserved" && sent.size === 0) {
      await voidReservation(metered.reservation.id);
    }
    if (!(error instanceof ProviderRefusedError)) throw error;
    noteProviderRefused("tool_results");
    await record(turn.chatId, {
      kind: "notice",
      code: ASSISTANT_NOTICE.UNAVAILABLE,
      eventId: round.idle.id,
    });
    await releaseTurn(turn.chatId);
    return { ended: true, firstEventId };
  }
  return { ended: false, firstEventId };
};

const relays = new Map<string, Promise<void>>();

const failTurn = async (chatId: string, reason: string, error?: unknown) => {
  logger.error("assistant.turn_failed", { chatId, reason, error: errorName(error) });
  const code =
    error instanceof ProviderRefusedError ? ASSISTANT_NOTICE.UNAVAILABLE : ASSISTANT_NOTICE.ERROR;
  await record(chatId, { kind: "notice", code });
  await releaseTurn(chatId);
};

/** Pause before attaching to a session stream again after it closed mid-turn. */
const REATTACH_MS = 1_000;

/**
 * Drives a turn to its end in this process, whether or not anyone watches:
 * advance at every idle until the session ends the turn. A stream the API
 * closes mid-turn is attached again. The webhook and opening the chat call
 * `advanceTurn` when no relay is running.
 */
const relay = async (turn: Advance): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    for (let attached = 0; !controller.signal.aborted; attached++) {
      if (attached > 0) await new Promise((resolve) => setTimeout(resolve, REATTACH_MS));
      const live = turn.driver.stream(turn.sessionId, controller.signal);
      await live.ready;
      if (await advanceTurn(turn)) return;
      for await (const item of live) {
        if (item.kind !== "event") continue;
        const { type } = item.event;
        if (type !== "session.status_idle" && type !== "session.status_terminated") continue;
        if (await advanceTurn(turn)) return;
        // Deleted mid-turn: the chat and its turn are gone.
        if (!(await isTurnRunning(turn.chatId))) return;
      }
      if (!(await isTurnRunning(turn.chatId))) return;
    }
    if (await isTurnRunning(turn.chatId)) await failTurn(turn.chatId, "timeout");
  } catch (error) {
    await failTurn(turn.chatId, "relay_error", error);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

/** Follows a turn in this process unless a relay here already does. */
const startRelay = (turn: Advance) => {
  if (relays.has(turn.chatId)) return;
  const running = inChat("assistant.relay", turn.chatId, () => relay(turn)).finally(() =>
    relays.delete(turn.chatId)
  );
  relays.set(turn.chatId, running);
};

/** Sends the prepared input into the session and starts the relay. Answers the turn's start: its message's event id. */
export const sendTurn = async (turn: PreparedTurn): Promise<string> => {
  let startEventId: string;
  try {
    const sent = await turn.driver.sendEvents(turn.sessionId, turn.input);
    // Carried tool results go first; the turn, and its step, start at the message.
    startEventId = (sent.find((event) => event.type === "user.message") ?? sent[0]!).id;
    await dropHeldAnswers(turn.chatId, turn.carriedToolUseIds);
    await attachStepEvent(turn.reservationId, { sessionId: turn.sessionId, eventId: startEventId });
    await db
      .update(assistantChats)
      .set({ turnStartEventId: startEventId })
      .where(eq(assistantChats.id, turn.chatId));
  } catch (error) {
    await voidReservation(turn.reservationId);
    await failTurn(turn.chatId, "send_failed", error);
    if (error instanceof ProviderRefusedError) {
      noteProviderRefused("send_events");
      throw providerUnavailable();
    }
    throw error;
  }
  startRelay({ ...turn, startEventId });
  return startEventId;
};

/**
 * A running turn rebuilt from its chat, to advance it outside the request
 * that started it. `null` when no turn runs or the user is gone.
 */
const turnOf = async (chat: typeof assistantChats.$inferSelect): Promise<Advance | null> => {
  if (chat.turnStatus !== "running" || !chat.sessionId || !chat.turnStartEventId) return null;
  const [owner] = await db
    .select({ name: user.name, email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, chat.userId))
    .limit(1);
  if (!owner) return null;
  return {
    auth: {
      sessionId: `assistant:${chat.id}`,
      userId: chat.userId,
      userName: owner.name,
      userEmail: owner.email,
      emailVerified: Boolean(owner.emailVerified),
      channel: "assistant",
    },
    chatId: chat.id,
    organizationId: chat.organizationId,
    sessionId: chat.sessionId,
    startEventId: chat.turnStartEventId,
    language: await toolLanguage(chat.userId),
    driver: assistantDriver(),
  };
};

/**
 * The `session.status_idled` webhook's step: advance the running turn of the
 * chat that owns the session. `ignored` when no chat or no turn matches.
 */
export const advanceIdledSession = async (sessionId: string): Promise<"advanced" | "ignored"> => {
  const [chat] = await db
    .select()
    .from(assistantChats)
    .where(eq(assistantChats.sessionId, sessionId))
    .limit(1);
  const turn = chat ? await turnOf(chat) : null;
  if (!turn) return "ignored";
  await advanceTurn(turn);
  return "advanced";
};

/**
 * How long a tool call may wait for its webhook before opening the chat
 * counts it as missed. The relay or the webhook answers within seconds.
 */
export const MISSED_WEBHOOK_GRACE_MS = 10_000;

/** When the session last stopped for tool calls it still waits on, or `null`. */
const waitingSince = (events: SessionEvent[]): Date | null => {
  const last = events.findLast(
    (event) => event.type === "session.status_idle" || event.type === "session.status_terminated"
  );
  if (last?.type !== "session.status_idle" || last.stop_reason.type !== "requires_action") {
    return null;
  }
  const answered = new Set(
    events.flatMap((event) =>
      event.type === "user.custom_tool_result" ? [event.custom_tool_use_id] : []
    )
  );
  if (last.stop_reason.event_ids.every((id) => answered.has(id))) return null;
  return new Date(last.processed_at);
};

/**
 * Opening a chat, or the chat list, catches up on missed webhooks: a turn
 * that has waited on an unanswered tool call past the grace, with no relay in
 * this process, is advanced and then followed to its end. No polling. Never
 * throws; a failure leaves the chat as it was.
 */
export const resumeStalledTurns = async (args: {
  userId: string;
  chatId?: string;
}): Promise<void> => {
  const chats = await db
    .select()
    .from(assistantChats)
    .where(
      and(
        eq(assistantChats.userId, args.userId),
        eq(assistantChats.turnStatus, "running"),
        args.chatId ? eq(assistantChats.id, args.chatId) : undefined
      )
    );
  for (const chat of chats) {
    if (relays.has(chat.id) || !isAiFeatureAvailable("assistant", chat.organizationId)) continue;
    try {
      const turn = await turnOf(chat);
      if (!turn) continue;
      const events = await turn.driver.listEvents(turn.sessionId, { afterId: turn.startEventId });
      const since = waitingSince(events);
      if (!since || Date.now() - since.getTime() < MISSED_WEBHOOK_GRACE_MS) continue;
      aiSignal("assistant.webhook_missed", { chatId: chat.id });
      if (await advanceTurn(turn)) continue;
      startRelay(turn);
    } catch (error) {
      logger.error("assistant.resume_failed", { chatId: chat.id, error: errorName(error) });
    }
  }
};

/** Waits for every relay this process runs; tests and shutdown use it. */
export const settleRelays = async (): Promise<void> => {
  await Promise.allSettled([...relays.values()]);
};

const cardNotFound = () => new AppError({ message: "Card not found", code: 404 });

const cardSettled = (status: string) =>
  new AppError({
    message: "This card is already decided",
    code: 409,
    publicContext: { code: PENDING_ACTION_SETTLED, status },
  });

const REJECT_TOOL = "reject_request";

/** The stored arguments, with a reject card's reason replaced by the one the user confirmed. */
const inputWithReason = (
  action: PendingActionRow,
  reason: string | null | undefined
): Record<string, unknown> => {
  if (reason === undefined) return action.input;
  if (action.toolName !== REJECT_TOOL) {
    throw new AppError({
      message: "Only a reject card takes a reason",
      code: 422,
      publicContext: { code: "REASON_NOT_ALLOWED" },
    });
  }
  const { reason: _proposed, ...rest } = action.input;
  const typed = reason?.trim();
  return typed ? { ...rest, reason: typed } : rest;
};

/**
 * Confirms or declines one of the caller's cards. Confirm runs the stored
 * arguments with fresh guards on channel `assistant`; a refusal keeps the
 * card open with the reason, to try again, and answers nothing. Either
 * decision settles the card and holds its answer; the last open card of a
 * round sends the round, and the Assistant writes on as a turn the client
 * follows with `GET .../stream`. Refused (403) when the organization no
 * longer allows the Assistant, 409 while another answer of the caller's runs.
 */
export const decideCard = async (args: {
  auth: AuthSession;
  pendingActionId: string;
  decision: "confirm" | "decline";
  /** A reject card's reason as the user left it; `undefined` keeps the proposed one. */
  reason?: string | null;
}): Promise<CardDecision> => {
  const { auth } = args;
  const action = await pendingActionById(args.pendingActionId);
  if (!action || action.userId !== auth.userId) throw cardNotFound();
  const chat = await getOwnChat({ userId: auth.userId, chatId: action.chatId });
  if (action.status !== "open") throw cardSettled(action.status);
  const input = inputWithReason(action, args.decision === "confirm" ? args.reason : undefined);
  await assertAiEligible({
    userId: auth.userId,
    organizationId: chat.organizationId,
    feature: "assistant",
  });
  if (providerRefusedRecently()) throw providerUnavailable();
  await claimTurn(chat.id, auth.userId);

  let running = false;
  try {
    const language = await toolLanguage(auth.userId);
    let settled: PendingActionRow | null;
    if (args.decision === "confirm") {
      const write = await runConfirmedWrite({
        auth,
        organizationId: chat.organizationId,
        language,
        name: action.toolName,
        input,
      });
      if (!write.ok) {
        const code = write.error.context?.code;
        const row = await recordCardError(action.id, {
          message: write.error.message,
          code: typeof code === "string" ? code : null,
        });
        return { card: presentCard(row), turnRunning: false };
      }
      settled = await settleCard(action, {
        status: "confirmed",
        input,
        result: write.result,
        answer: { text: write.text, isError: false },
      });
    } else {
      settled = await settleCard(action, { status: "declined", answer: DECLINED_ANSWER });
    }
    if (!settled) throw cardSettled("decided");

    const turn: Advance = {
      auth: { ...auth, channel: "assistant" },
      chatId: chat.id,
      organizationId: chat.organizationId,
      sessionId: action.sessionId,
      startEventId: action.roundEventId,
      language,
      driver: assistantDriver(),
    };
    const sent = await sendDecidedRound(turn, action);
    if (sent) {
      await db
        .update(assistantChats)
        .set({ turnStartEventId: sent })
        .where(eq(assistantChats.id, chat.id));
      running = true;
      startRelay({ ...turn, startEventId: sent });
    }
    return { card: presentCard(settled), turnRunning: running };
  } finally {
    if (!running) await unclaimTurn(chat.id);
  }
};

/**
 * Sends the card's round when no card in it is open any more. Answers the
 * first sent event, where the Assistant's next turn starts, or `null` when
 * nothing was sent (cards still open, or the meter refused and holds it).
 */
const sendDecidedRound = async (
  turn: Advance,
  action: PendingActionRow
): Promise<string | null> => {
  if ((await openCardsInRound(turn.chatId, action.roundEventId)) > 0) return null;
  const all = await turn.driver.listEvents(turn.sessionId);
  const at = all.findIndex((event) => event.id === action.roundEventId);
  const idle = all[at];
  if (idle?.type !== "session.status_idle") return null;
  // The model calls since the user's message count toward the turn's 10.
  const asked = all.slice(0, at).findLastIndex((event) => event.type === "user.message");
  const sent = await sendRound(turn, {
    idle,
    events: all.slice(asked + 1, at + 1),
    readUsage: () => turn.driver.readUsage(turn.sessionId),
  });
  return sent.ended ? null : sent.firstEventId;
};
