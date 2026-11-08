import { asc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/db.js";
import { assistantModelCalls } from "../../../db/schema/assistant-meter-schema.js";
import {
  assistantChatMessages,
  assistantChats,
  assistantPendingActions,
  assistantRejectedTurns,
} from "../../../db/schema/assistant-schema.js";
import { appLanguage } from "../../../db/schema/user-settings-schema.js";
import type { AuthSession } from "../../../middleware/authSession.js";
import { drainSessionDeletions } from "../../../services/assistant/chatLifecycle.js";
import { createChat, deleteChat } from "../../../services/assistant/chatServices.js";
import { assistantDriver } from "../../../services/assistant/driver/index.js";
import { ProviderRefusedError } from "../../../services/assistant/driver/types.js";
import { usedSum } from "../../../services/assistant/meter/meter.js";
import { isTurnRunning, prepareTurn, sendTurn } from "../../../services/assistant/turnServices.js";
import { ASSISTANT_NOTICE, REJECTED_MESSAGE } from "../../../services/assistant/types.js";
import { upsertUserSettings } from "../../../services/userSettings/userSettingsServices.js";
import AppError from "../../../utils/appError.js";
import type { CaseRun } from "../report.js";
import { resolveExpectation, resolveMessage } from "../resolve.js";
import { scoreCase } from "../score.js";
import type { EvalCase, Judge, Observed, SeedRefs } from "../types.js";

/** Anthropic refused for the workspace's spend limit or credits: the run stops, no retry. */
export class SpendLimitError extends Error {
  constructor(readonly caseId: string) {
    super("Anthropic refused the call: spend limit or credits");
    this.name = "SpendLimitError";
  }
}

const SPEND_WORDING = /usage limit|spend limit|credit balance/i;

export const isSpendRefusal = (error: unknown): boolean => {
  if (error instanceof ProviderRefusedError) return true;
  if (error instanceof AppError) {
    return error.errors[0]?.publicContext.code === ASSISTANT_NOTICE.UNAVAILABLE;
  }
  const api = error as {
    status?: unknown;
    error?: { error?: { type?: unknown } };
    message?: unknown;
  };
  return (
    api.status === 402 ||
    api.error?.error?.type === "billing_error" ||
    (api.status === 400 && typeof api.message === "string" && SPEND_WORDING.test(api.message))
  );
};

const TURN_WAIT_MS = 5 * 60_000;
const POLL_MS = 250;

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until the relay ends the turn, or the wait gives up (the relay records its own timeout). */
const waitForTurn = async (chatId: string) => {
  const until = performance.now() + TURN_WAIT_MS;
  while (performance.now() < until && (await isTurnRunning(chatId))) await realDelay(POLL_MS);
};

const observe = async (chatId: string): Promise<Observed> => {
  const [chat] = await db
    .select({ sessionId: assistantChats.sessionId })
    .from(assistantChats)
    .where(eq(assistantChats.id, chatId));
  const events = chat?.sessionId ? await assistantDriver().listEvents(chat.sessionId) : [];
  const messages = await db
    .select()
    .from(assistantChatMessages)
    .where(eq(assistantChatMessages.chatId, chatId))
    .orderBy(asc(assistantChatMessages.seq));
  const cards = await db
    .select()
    .from(assistantPendingActions)
    .where(eq(assistantPendingActions.chatId, chatId));
  return {
    calls: events.flatMap((event) =>
      event.type === "agent.custom_tool_use" ? [{ tool: event.name, input: event.input }] : []
    ),
    cards: cards.map((card) => ({
      tool: card.toolName,
      input: card.input,
      preview: card.preview,
      authorNames: card.authorNames,
    })),
    text: messages
      .filter((message) => message.kind === "assistant")
      .map((message) => message.text ?? "")
      .join("\n"),
    notices: messages.flatMap((message) =>
      message.kind === "notice" && message.code ? [message.code] : []
    ),
    rejected: messages.some(
      (message) => message.kind === "user" && message.code === REJECTED_MESSAGE
    ),
  };
};

const ledgerOf = async (chatId: string) => {
  const [row] = await db
    .select({
      cost: usedSum,
      input: sql<number>`coalesce(sum(${assistantModelCalls.inputTokens}), 0)::int`,
      cacheWrite: sql<number>`coalesce(sum(coalesce(${assistantModelCalls.cacheWrite5mTokens}, 0) + coalesce(${assistantModelCalls.cacheWrite1hTokens}, 0)), 0)::int`,
      cacheRead: sql<number>`coalesce(sum(${assistantModelCalls.cacheReadTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${assistantModelCalls.outputTokens}), 0)::int`,
    })
    .from(assistantModelCalls)
    .where(eq(assistantModelCalls.chatId, chatId));
  return {
    costMicroUsd: Math.round(row?.cost ?? 0),
    tokens: {
      input: row?.input ?? 0,
      cacheWrite: row?.cacheWrite ?? 0,
      cacheRead: row?.cacheRead ?? 0,
      output: row?.output ?? 0,
    },
  };
};

/** Between cases: the persona's chats (and their sessions) and rejected turns go. */
const cleanUp = async (userId: string, chatId: string) => {
  await deleteChat({ userId, chatId }).catch(() => undefined);
  await db.delete(assistantRejectedTurns).where(eq(assistantRejectedTurns.userId, userId));
  await drainSessionDeletions().catch(() => undefined);
};

/**
 * One attempt at a case, in-process: a new chat for the persona in the case's
 * language, the message through the turn service (screen, meter, session,
 * relay, tools; no webhook), then what the turn left behind, scored. Cards stay
 * open: no case ever confirms one.
 */
export const runCase = async (args: {
  evalCase: EvalCase;
  seed: SeedRefs;
  judge: Judge;
}): Promise<CaseRun> => {
  const { evalCase, seed, judge } = args;
  const persona = seed.users[evalCase.persona];
  await upsertUserSettings(persona.id, {
    language: evalCase.lang === "cs" ? appLanguage.Czech : appLanguage.English,
  });
  const auth: AuthSession = {
    sessionId: `eval:${evalCase.id}`,
    userId: persona.id,
    userName: persona.name,
    userEmail: `${persona.id.toLowerCase()}@report-e2e.test`,
    emailVerified: true,
    channel: "app",
  };

  const chat = await createChat({ userId: persona.id, organizationId: seed.organizationId });
  // The column defaults to the database clock, which isn't the eval's day.
  await db
    .update(assistantChats)
    .set({ lastMessageAt: new Date() })
    .where(eq(assistantChats.id, chat.id));

  const started = performance.now();
  let error: string | undefined;
  try {
    const turn = await prepareTurn({ auth, chatId: chat.id, text: resolveMessage(evalCase, seed) });
    if (!turn.rejected) {
      await sendTurn(turn);
      await waitForTurn(chat.id);
    }
  } catch (caught) {
    if (isSpendRefusal(caught)) {
      await cleanUp(persona.id, chat.id);
      throw new SpendLimitError(evalCase.id);
    }
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : "unknown error";
  }
  const latencyMs = Math.round(performance.now() - started);

  try {
    const observed = await observe(chat.id);
    const ledger = await ledgerOf(chat.id);
    if (observed.notices.includes(ASSISTANT_NOTICE.UNAVAILABLE)) {
      throw new SpendLimitError(evalCase.id);
    }
    const score = error
      ? { pass: false, failedCheck: `error: ${error}`, falseRefusal: false, judge: [] }
      : await scoreCase({
          expectation: resolveExpectation(evalCase, seed),
          observed,
          judge,
          lang: evalCase.lang,
        });
    return { score, observed, latencyMs, ...ledger, ...(error ? { error } : {}) };
  } catch (caught) {
    if (isSpendRefusal(caught)) throw new SpendLimitError(evalCase.id);
    throw caught;
  } finally {
    await cleanUp(persona.id, chat.id);
  }
};
