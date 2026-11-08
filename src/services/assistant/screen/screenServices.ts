import { and, desc, eq } from "drizzle-orm";
import { config } from "../../../config.js";
import { db } from "../../../db/db.js";
import {
  assistantChatMessages,
  type AssistantRejectionReason,
} from "../../../db/schema/assistant-schema.js";
import { logger } from "../../../middleware/logger.js";
import { USER_TEXT_KEY } from "../../../tools/userText.js";
import { errorName } from "../../../utils/errorName.js";
import { currentAgentKnowledge } from "../agent/agentSync.js";
import type { AssistantDriver } from "../driver/types.js";

/** What a flagged user-written value becomes in the tool result the session reads. */
export const WITHHELD = "[withheld: looked like instructions]";

class ScreenTimeoutError extends Error {
  constructor() {
    super("The screen took too long");
    this.name = "ScreenTimeoutError";
  }
}

/**
 * Runs one screen call under the timeout, so even a call that ignores its
 * signal fails closed in time. Every screen call goes through here.
 */
const screenCall = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ScreenTimeoutError());
    }, config.assistant.screenTimeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const failureReason = (error: unknown) =>
  error instanceof ScreenTimeoutError ? "timeout" : "error";

const previousAssistantMessage = async (chatId: string): Promise<string | null> => {
  const [row] = await db
    .select({ text: assistantChatMessages.text })
    .from(assistantChatMessages)
    .where(
      and(eq(assistantChatMessages.chatId, chatId), eq(assistantChatMessages.kind, "assistant"))
    )
    .orderBy(desc(assistantChatMessages.seq))
    .limit(1);
  return row?.text ?? null;
};

export type MessageScreen =
  | { outcome: "pass" }
  | { outcome: "rejected"; reason: AssistantRejectionReason }
  | { outcome: "failed" };

/**
 * The screen of one user message before it reaches the session: the message,
 * the previous Assistant message, and the help article index as the scope.
 * Haiku's own refusal counts as an attack. Never throws: a failure or a
 * timeout answers `failed`, and the caller sends nothing.
 */
export const screenMessage = async (args: {
  driver: AssistantDriver;
  chatId: string;
  message: string;
  language: "en" | "cs";
}): Promise<MessageScreen> => {
  try {
    const input = {
      message: args.message,
      previousAssistantMessage: await previousAssistantMessage(args.chatId),
      language: args.language,
      articleIndex: currentAgentKnowledge()?.index ?? null,
    };
    const { verdict } = await screenCall((signal) => args.driver.screen(input, signal));
    if ("refused" in verdict || verdict.attack) return { outcome: "rejected", reason: "attack" };
    if (!verdict.inScope) return { outcome: "rejected", reason: "off_topic" };
    return { outcome: "pass" };
  } catch (error) {
    logger.warn("assistant.screen_failed", {
      chatId: args.chatId,
      purpose: "message",
      reason: failureReason(error),
      error: errorName(error),
    });
    return { outcome: "failed" };
  }
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type UserTextSlot = { [USER_TEXT_KEY]: string };

const isUserText = (value: Json): value is UserTextSlot =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof value[USER_TEXT_KEY] === "string";

/** Every `{"user_text": …}` slot in a tool result, in document order. */
const userTextSlots = (value: Json, into: UserTextSlot[] = []): UserTextSlot[] => {
  if (isUserText(value)) into.push(value);
  else if (Array.isArray(value)) for (const item of value) userTextSlots(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) userTextSlots(child, into);
  }
  return into;
};

const parse = (text: string): Json | undefined => {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
};

/**
 * The screen of one model response's tool results: one call over every value
 * people wrote (the declared `user_text` slots). A flagged value becomes
 * `WITHHELD`; when the call fails or Haiku refuses, every value in the
 * response is. Answers the texts to send, in order. No call without user text.
 */
export const screenToolResults = async (args: {
  driver: AssistantDriver;
  chatId: string;
  texts: string[];
}): Promise<string[]> => {
  const parsed = args.texts.map(parse);
  const slots = parsed.flatMap((value) => (value === undefined ? [] : userTextSlots(value)));
  if (slots.length === 0) return args.texts;

  let withheld: Set<number>;
  try {
    const { verdict } = await screenCall((signal) =>
      args.driver.screenToolText({ values: slots.map((slot) => slot[USER_TEXT_KEY]) }, signal)
    );
    withheld =
      "refused" in verdict
        ? new Set(slots.keys())
        : new Set(verdict.flagged.filter((i) => i in slots));
    if (withheld.size > 0) {
      logger.warn("assistant.tool_text_withheld", {
        chatId: args.chatId,
        reason: "refused" in verdict ? "refused" : "flagged",
        count: withheld.size,
      });
    }
  } catch (error) {
    withheld = new Set(slots.keys());
    logger.warn("assistant.screen_failed", {
      chatId: args.chatId,
      purpose: "tool_text",
      reason: failureReason(error),
      error: errorName(error),
    });
    logger.warn("assistant.tool_text_withheld", {
      chatId: args.chatId,
      reason: "screen_failed",
      count: withheld.size,
    });
  }
  if (withheld.size === 0) return args.texts;

  slots.forEach((slot, index) => {
    if (withheld.has(index)) slot[USER_TEXT_KEY] = WITHHELD;
  });
  return parsed.map((value, index) =>
    value === undefined ? args.texts[index]! : JSON.stringify(value)
  );
};
