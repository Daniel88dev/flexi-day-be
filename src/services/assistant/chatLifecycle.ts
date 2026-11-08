import { and, eq, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { config } from "../../config.js";
import { db, type DbTransaction } from "../../db/db.js";
import {
  assistantChats,
  assistantHeldAnswers,
  assistantPendingActions,
  assistantRejectedTurns,
  assistantSessionDeletions,
} from "../../db/schema/assistant-schema.js";
import { logger } from "../../middleware/logger.js";
import AppError from "../../utils/appError.js";
import { errorName } from "../../utils/errorName.js";
import { getRequestContext, type RequestContext } from "../../utils/requestStore.js";
import { assistantDriver } from "./driver/index.js";

/** A chat takes no more messages this long after its last one, and its session is deleted. */
export const CHAT_IDLE_DAYS = 30;
/** The display record goes this long after the chat's last message. */
export const CHAT_RETENTION_DAYS = 180;

const DAY_MS = 86_400_000;

export type ChatClosedReason = "length" | "idle";

export const CHAT_CLOSED = "ASSISTANT_CHAT_CLOSED";

/** Why a chat takes no more messages, or `null` while it is open. The length ceiling wins. */
export const closedReason = (
  chat: { contextTokens: number; lastMessageAt: Date },
  now = new Date()
): ChatClosedReason | null => {
  if (chat.contextTokens >= config.assistant.chatTokenCeiling) return "length";
  if (chat.lastMessageAt.getTime() <= now.getTime() - CHAT_IDLE_DAYS * DAY_MS) return "idle";
  return null;
};

export const chatClosed = (reason: ChatClosedReason) =>
  new AppError({
    message: "This chat is closed",
    code: 409,
    publicContext: { code: CHAT_CLOSED, reason },
  });

/** 409 `ASSISTANT_CHAT_CLOSED` with the reason unless the chat still takes messages. */
export const assertChatOpen = (chat: { contextTokens: number; lastMessageAt: Date }): void => {
  const reason = closedReason(chat);
  if (reason) throw chatClosed(reason);
};

type Client = DbTransaction | typeof db;

const enqueueSessions = async (client: Client, sessionIds: (string | null)[]) => {
  const ids = [...new Set(sessionIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return;
  await client
    .insert(assistantSessionDeletions)
    .values(ids.map((sessionId) => ({ sessionId })))
    .onConflictDoNothing();
  requestSessionDrain();
};

/**
 * Deletes the chats `where` selects, their display record, cards and held
 * answers by cascade, and queues their sessions for the driver. Rejected
 * turns keep their count with no chat.
 */
const deleteChatsWhere = async (client: Client, where: SQL): Promise<number> => {
  const run = async (tx: Client) => {
    const deleted = await tx
      .delete(assistantChats)
      .where(where)
      .returning({ sessionId: assistantChats.sessionId });
    await enqueueSessions(
      tx,
      deleted.map((row) => row.sessionId)
    );
    return deleted.length;
  };
  return client === db ? db.transaction(run) : run(client);
};

/** A member's chats in one organization: they left it, were removed, or were erased. */
export const deleteMemberChats = (
  args: { organizationId: string; userId: string },
  tx: Client = db
): Promise<number> =>
  deleteChatsWhere(
    tx,
    and(
      eq(assistantChats.organizationId, args.organizationId),
      eq(assistantChats.userId, args.userId)
    )!
  );

/** Every chat of the user, in every organization: their account is being deleted. */
export const deleteUserChats = (userId: string, tx: Client = db): Promise<number> =>
  deleteChatsWhere(tx, eq(assistantChats.userId, userId));

/** Every chat of the organizations, before the organizations themselves go. */
export const deleteOrganizationChats = (
  organizationIds: string[],
  tx: Client = db
): Promise<number> =>
  organizationIds.length === 0
    ? Promise.resolve(0)
    : deleteChatsWhere(tx, inArray(assistantChats.organizationId, organizationIds));

/** One chat, the caller's own, already checked. */
export const deleteChatById = (chatId: string): Promise<number> =>
  deleteChatsWhere(db, eq(assistantChats.id, chatId));

/**
 * Day 30: the chat is closed and its session goes. Open cards become not
 * taken and held answers are dropped, since nothing will ever be sent again.
 */
const closeIdleChats = async (now: Date): Promise<number> => {
  const cutoff = new Date(now.getTime() - CHAT_IDLE_DAYS * DAY_MS);
  return db.transaction(async (tx) => {
    const closed = await tx
      .select({ id: assistantChats.id, sessionId: assistantChats.sessionId })
      .from(assistantChats)
      .where(and(isNotNull(assistantChats.sessionId), lte(assistantChats.lastMessageAt, cutoff)))
      .for("update", { skipLocked: true });
    if (closed.length === 0) return 0;
    const chatIds = closed.map((row) => row.id);
    await enqueueSessions(
      tx,
      closed.map((row) => row.sessionId)
    );
    await tx
      .update(assistantPendingActions)
      .set({ status: "not_taken", result: null, error: null, decidedAt: now })
      .where(
        and(
          inArray(assistantPendingActions.chatId, chatIds),
          eq(assistantPendingActions.status, "open")
        )
      );
    await tx.delete(assistantHeldAnswers).where(inArray(assistantHeldAnswers.chatId, chatIds));
    await tx
      .update(assistantChats)
      .set({ sessionId: null, turnStatus: "idle", turnStartedAt: null })
      .where(inArray(assistantChats.id, chatIds));
    return closed.length;
  });
};

/** Day 180: the chat, its display record, its cards and the rejected turns tied to it. */
const deleteExpiredChats = async (now: Date): Promise<number> => {
  const cutoff = new Date(now.getTime() - CHAT_RETENTION_DAYS * DAY_MS);
  return db.transaction(async (tx) => {
    const expired = sql`${assistantChats.lastMessageAt} < ${cutoff}`;
    await tx
      .delete(assistantRejectedTurns)
      .where(
        inArray(
          assistantRejectedTurns.chatId,
          tx.select({ id: assistantChats.id }).from(assistantChats).where(expired)
        )
      );
    return deleteChatsWhere(tx, expired);
  });
};

/** One pass of the drain: every queued session, deleted through the driver. */
const drainOnce = async (): Promise<{ deleted: number; failed: number }> => {
  const queued = await db
    .select({ sessionId: assistantSessionDeletions.sessionId })
    .from(assistantSessionDeletions)
    .limit(500);
  let deleted = 0;
  let failed = 0;
  for (const { sessionId } of queued) {
    try {
      await assistantDriver().deleteSession(sessionId);
      await db
        .delete(assistantSessionDeletions)
        .where(eq(assistantSessionDeletions.sessionId, sessionId));
      deleted += 1;
    } catch (error) {
      failed += 1;
      await db
        .update(assistantSessionDeletions)
        .set({ attempts: sql`${assistantSessionDeletions.attempts} + 1` })
        .where(eq(assistantSessionDeletions.sessionId, sessionId));
      logger.error("assistant.session_delete_failed", { error: errorName(error) });
    }
  }
  return { deleted, failed };
};

let draining: Promise<{ deleted: number; failed: number }> | null = null;

/**
 * Deletes every queued session through the driver; a failure stays queued
 * for the nightly tick. Runs one pass at a time in this process.
 */
export const drainSessionDeletions = async (): Promise<{ deleted: number; failed: number }> => {
  while (draining) await draining.catch(() => undefined);
  draining = drainOnce();
  try {
    return await draining;
  } finally {
    draining = null;
  }
};

/** Tests: waits for a drain started after a response. */
export const settleSessionDeletions = async (): Promise<void> => {
  while (draining) await draining.catch(() => undefined);
};

const drainAfter = new WeakSet<RequestContext>();

/**
 * Marks the current request: its sessions are deleted once the response is
 * sent, when its transaction has committed. Outside a request the nightly
 * tick drains.
 */
const requestSessionDrain = (): void => {
  const context = getRequestContext();
  if (context) drainAfter.add(context);
};

/** Whether the request queued session deletes; answers true once. */
export const takeSessionDrainRequest = (context: RequestContext): boolean =>
  drainAfter.delete(context);

export type ChatRetentionCounts = {
  closed: number;
  deleted: number;
  sessionsDeleted: number;
  sessionsFailed: number;
};

/** The nightly sweep: sessions on day 30, chats on day 180, then every queued session delete. */
export const retainAssistantChats = async (now = new Date()): Promise<ChatRetentionCounts> => {
  const closed = await closeIdleChats(now);
  const deleted = await deleteExpiredChats(now);
  const drained = await drainSessionDeletions();
  return {
    closed,
    deleted,
    sessionsDeleted: drained.deleted,
    sessionsFailed: drained.failed,
  };
};
