import { and, eq, lt } from "drizzle-orm";
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
import { answerAssistantToolCall } from "./assistantTools.js";
import { getOwnChat, roleIn, type ChatRow } from "./chatServices.js";
import { assistantDriver } from "./driver/index.js";
import type { AssistantDriver, SessionEvent, SessionInputEvent } from "./driver/types.js";
import { ASSISTANT_NOTICE, TITLE_MAX_LENGTH } from "./types.js";

/** A turn older than this is taken for dead (a crashed process) and may be reclaimed. */
export const STALE_TURN_MS = 5 * 60_000;
/** The relay gives up on a turn after this long and records an error notice. */
export const TURN_TIMEOUT_MS = 4 * 60_000;

export const TURN_RUNNING = "ASSISTANT_TURN_RUNNING";

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

/** What a send hands from its checks to its stream. */
export type PreparedTurn = {
  auth: AuthSession;
  chatId: string;
  organizationId: string;
  sessionId: string;
  language: ToolLanguage;
  input: SessionInputEvent[];
  driver: AssistantDriver;
};

/**
 * Everything a send checks and writes before its stream opens: the chat is
 * the caller's, the organization still allows the Assistant (403 with the
 * reason otherwise), no other turn of the caller's runs (409), then the
 * user's text in the display record and the session, created on first use.
 */
export const prepareTurn = async (args: {
  auth: AuthSession;
  chatId: string;
  text: string;
}): Promise<PreparedTurn> => {
  const { auth } = args;
  const chat = await getOwnChat({ userId: auth.userId, chatId: args.chatId });
  await assertAiEligible({
    userId: auth.userId,
    organizationId: chat.organizationId,
    feature: "assistant",
  });
  await claimTurn(chat.id, auth.userId);

  try {
    const driver = assistantDriver();
    const now = new Date();
    const language = await toolLanguage(auth.userId);
    let sessionId = chat.sessionId;
    if (!sessionId) {
      const created = await driver.createSession({
        chatId: chat.id,
        organizationId: chat.organizationId,
      });
      sessionId = created.sessionId;
      await db
        .update(assistantChats)
        .set({ sessionId, agentVersion: created.agentVersion })
        .where(eq(assistantChats.id, chat.id));
    }

    await record(chat.id, { kind: "user", text: args.text });
    await db
      .update(assistantChats)
      .set({ title: chat.title ?? args.text.slice(0, TITLE_MAX_LENGTH), lastMessageAt: now })
      .where(eq(assistantChats.id, chat.id));

    const input: SessionInputEvent[] = [
      { type: "user.message", content: [{ type: "text", text: args.text }] },
    ];
    if (!chat.sessionId || utcDay(chat.lastMessageAt) !== utcDay(now)) {
      input.push(await contextMessage({ auth, chat, language, now }));
    }
    return {
      auth,
      chatId: chat.id,
      organizationId: chat.organizationId,
      sessionId,
      language,
      input,
      driver,
    };
  } catch (error) {
    await releaseTurn(chat.id);
    throw error;
  }
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
 * One idempotent step of a turn: list the turn's events, record the
 * Assistant's text, run the reads it asked for and answer each tool call
 * exactly once (the display row keyed on the tool-use event id is the claim).
 * Answers whether the turn has ended. Safe to run again at any point.
 */
export const advanceTurn = async (turn: Advance): Promise<boolean> => {
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
      await record(turn.chatId, {
        kind: "notice",
        code: ASSISTANT_NOTICE.ERROR,
        eventId: event.id,
      });
    }
  }

  const last = events.findLast(
    (event) => event.type === "session.status_idle" || event.type === "session.status_terminated"
  );
  if (!last) return false;
  if (isTurnEnd(last)) {
    await releaseTurn(turn.chatId);
    return true;
  }
  if (last.type !== "session.status_idle" || last.stop_reason.type !== "requires_action") {
    return false;
  }

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
    const answer = await answerAssistantToolCall({
      auth: turn.auth,
      organizationId: turn.organizationId,
      language: turn.language,
      name: call.name,
      input: call.input,
    });
    await db
      .update(assistantChatMessages)
      .set({ toolOutcome: answer.outcome })
      .where(
        and(
          eq(assistantChatMessages.chatId, turn.chatId),
          eq(assistantChatMessages.eventId, call.id)
        )
      );
    await turn.driver.answerToolCall(turn.sessionId, call.id, {
      text: answer.text,
      isError: answer.isError,
    });
  }
  return false;
};

const relays = new Map<string, Promise<void>>();

const failTurn = async (chatId: string, reason: string, error?: unknown) => {
  logger.error("assistant.turn_failed", { chatId, reason, error: errorName(error) });
  await record(chatId, { kind: "notice", code: ASSISTANT_NOTICE.ERROR });
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
  const running = relay(turn).finally(() => relays.delete(turn.chatId));
  relays.set(turn.chatId, running);
};

/** Sends the prepared input into the session and starts the relay. Answers the turn's first event id. */
export const sendTurn = async (turn: PreparedTurn): Promise<string> => {
  let startEventId: string;
  try {
    const sent = await turn.driver.sendEvents(turn.sessionId, turn.input);
    startEventId = sent[0]!.id;
    await db
      .update(assistantChats)
      .set({ turnStartEventId: startEventId })
      .where(eq(assistantChats.id, turn.chatId));
  } catch (error) {
    await failTurn(turn.chatId, "send_failed", error);
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
      logger.warn("assistant.webhook_missed", { chatId: chat.id });
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
