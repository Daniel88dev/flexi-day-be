import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/db.js";
import { assistantHeldAnswers, assistantPendingActions } from "../../db/schema/assistant-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import type { PendingCard } from "./types.js";

export type PendingActionRow = typeof assistantPendingActions.$inferSelect;

/** One tool result for the session, sent or still held. */
export type ToolAnswer = { toolUseId: string; text: string; isError: boolean };

/** What a declined card answers its tool call with. */
export const DECLINED_ANSWER: Omit<ToolAnswer, "toolUseId"> = {
  text: JSON.stringify({ outcome: "declined", message: "The user declined. Nothing changed." }),
  isError: false,
};

/** What an open card answers when the user sends a new message instead. */
export const NOT_TAKEN_ANSWER: Omit<ToolAnswer, "toolUseId"> = {
  text: JSON.stringify({
    outcome: "not_taken",
    message: "Not taken: the user sent a new message instead of confirming. Nothing changed.",
  }),
  isError: false,
};

export const presentCard = (row: PendingActionRow): PendingCard => ({
  id: row.id,
  chatId: row.chatId,
  toolUseId: row.toolUseId,
  tool: row.toolName,
  status: row.status,
  preview: row.preview,
  authorNames: row.authorNames,
  result: row.result ?? null,
  error: row.error ?? null,
  createdAt: row.createdAt.toISOString(),
  decidedAt: row.decidedAt?.toISOString() ?? null,
});

/** Parks a write as a pending action; a replayed step finds its row and writes nothing. */
export const parkPendingAction = async (
  action: Omit<
    typeof assistantPendingActions.$inferInsert,
    "id" | "status" | "result" | "error" | "createdAt" | "decidedAt"
  >
): Promise<void> => {
  await db
    .insert(assistantPendingActions)
    .values({ id: generateRandomUUID(), ...action })
    .onConflictDoNothing();
};

/** The chat's cards by tool-use event id, for the display record and the stream. */
export const cardsOf = async (
  chatId: string,
  toolUseIds?: string[]
): Promise<Map<string, PendingCard>> => {
  if (toolUseIds?.length === 0) return new Map();
  const rows = await db
    .select()
    .from(assistantPendingActions)
    .where(
      and(
        eq(assistantPendingActions.chatId, chatId),
        toolUseIds ? inArray(assistantPendingActions.toolUseId, toolUseIds) : undefined
      )
    );
  return new Map(rows.map((row) => [row.toolUseId, presentCard(row)]));
};

export const pendingActionById = async (id: string): Promise<PendingActionRow | null> => {
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(eq(assistantPendingActions.id, id))
    .limit(1);
  return row ?? null;
};

export const openCardsOf = (chatId: string): Promise<PendingActionRow[]> =>
  db
    .select()
    .from(assistantPendingActions)
    .where(
      and(eq(assistantPendingActions.chatId, chatId), eq(assistantPendingActions.status, "open"))
    )
    .orderBy(asc(assistantPendingActions.createdAt));

/** The round's cards still waiting on the user. */
export const openCardsInRound = async (chatId: string, roundEventId: string): Promise<number> =>
  (
    await db
      .select({ id: assistantPendingActions.id })
      .from(assistantPendingActions)
      .where(
        and(
          eq(assistantPendingActions.chatId, chatId),
          eq(assistantPendingActions.roundEventId, roundEventId),
          eq(assistantPendingActions.status, "open")
        )
      )
  ).length;

/**
 * Settles an open card, or answers `null` when it was no longer open (a
 * decision that lost a race). Settling and holding its answer happen together.
 */
export const settleCard = async (
  action: PendingActionRow,
  settled: {
    status: "confirmed" | "declined" | "not_taken";
    /** The arguments the write ran with, when the card changed them (a reject reason). */
    input?: Record<string, unknown>;
    result?: Record<string, unknown>;
    answer: Omit<ToolAnswer, "toolUseId">;
  }
): Promise<PendingActionRow | null> =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .update(assistantPendingActions)
      .set({
        status: settled.status,
        ...(settled.input ? { input: settled.input } : {}),
        result: settled.result ?? null,
        error: null,
        decidedAt: new Date(),
      })
      .where(
        and(eq(assistantPendingActions.id, action.id), eq(assistantPendingActions.status, "open"))
      )
      .returning();
    if (!row) return null;
    await tx
      .insert(assistantHeldAnswers)
      .values({
        id: generateRandomUUID(),
        chatId: action.chatId,
        roundEventId: action.roundEventId,
        toolUseId: action.toolUseId,
        ...settled.answer,
      })
      .onConflictDoNothing();
    return row;
  });

/** Keeps a refused confirm's reason on the open card, which can be tried again. */
export const recordCardError = async (
  id: string,
  error: { message: string; code: string | null }
): Promise<PendingActionRow> => {
  const [row] = await db
    .update(assistantPendingActions)
    .set({ error })
    .where(eq(assistantPendingActions.id, id))
    .returning();
  return row!;
};

export const holdAnswers = async (
  chatId: string,
  roundEventId: string,
  answers: ToolAnswer[]
): Promise<void> => {
  if (answers.length === 0) return;
  await db
    .insert(assistantHeldAnswers)
    .values(
      answers.map((answer) => ({ id: generateRandomUUID(), chatId, roundEventId, ...answer }))
    )
    .onConflictDoNothing();
};

type HeldRow = typeof assistantHeldAnswers.$inferSelect;

const asAnswer = (row: HeldRow): ToolAnswer => ({
  toolUseId: row.toolUseId,
  text: row.text,
  isError: row.isError,
});

/** Every answer the chat still holds, oldest first: what the next admitted message carries. */
export const heldAnswersOf = async (chatId: string): Promise<ToolAnswer[]> =>
  (
    await db
      .select()
      .from(assistantHeldAnswers)
      .where(eq(assistantHeldAnswers.chatId, chatId))
      .orderBy(asc(assistantHeldAnswers.createdAt), asc(assistantHeldAnswers.toolUseId))
  ).map(asAnswer);

/** The tool calls of a round whose answer is held. */
export const heldToolUseIds = async (chatId: string, roundEventId: string): Promise<Set<string>> =>
  new Set(
    (
      await db
        .select({ toolUseId: assistantHeldAnswers.toolUseId })
        .from(assistantHeldAnswers)
        .where(
          and(
            eq(assistantHeldAnswers.chatId, chatId),
            eq(assistantHeldAnswers.roundEventId, roundEventId)
          )
        )
    ).map((row) => row.toolUseId)
  );

/**
 * Takes a round's held answers to send them. Taking is the claim: two
 * advances of one round can't both send them.
 */
export const takeRoundAnswers = async (
  chatId: string,
  roundEventId: string
): Promise<{
  answers: ToolAnswer[];
  /** Puts back what wasn't sent, to go with the next admitted message. */
  restore: (sent: Set<string>) => Promise<void>;
}> => {
  const rows = await db
    .delete(assistantHeldAnswers)
    .where(
      and(
        eq(assistantHeldAnswers.chatId, chatId),
        eq(assistantHeldAnswers.roundEventId, roundEventId)
      )
    )
    .returning();
  rows.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.toolUseId.localeCompare(b.toolUseId)
  );
  return {
    answers: rows.map(asAnswer),
    restore: async (sent) => {
      const unsent = rows.filter((row) => !sent.has(row.toolUseId));
      if (unsent.length > 0) {
        await db.insert(assistantHeldAnswers).values(unsent).onConflictDoNothing();
      }
    },
  };
};

/** Drops held answers once the session has them. */
export const dropHeldAnswers = async (chatId: string, toolUseIds: string[]): Promise<void> => {
  if (toolUseIds.length === 0) return;
  await db
    .delete(assistantHeldAnswers)
    .where(
      and(
        eq(assistantHeldAnswers.chatId, chatId),
        inArray(assistantHeldAnswers.toolUseId, toolUseIds)
      )
    );
};
