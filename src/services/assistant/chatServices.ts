import { and, asc, desc, eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { assistantChatMessages, assistantChats } from "../../db/schema/assistant-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { aiEligibilityForUser, assertAiEligible } from "../aiFeatures/aiEligibility.js";
import { isAiFeatureAvailable } from "../aiFeatures/aiFeatureServices.js";
import { isAssistantPlan, planForOrganization } from "../billing/guards.js";
import { isOrganizationAdmin } from "../organization/organizationServices.js";
import { closedReason, deleteChatById } from "./chatLifecycle.js";
import { readWeeklyUsage } from "./meter/meter.js";
import { cardsOf } from "./pendingActions.js";
import type {
  AssistantOrganization,
  AssistantRole,
  ChatDetail,
  ChatSummary,
  DisplayMessage,
} from "./types.js";

export type ChatRow = typeof assistantChats.$inferSelect;

const chatNotFound = () => new AppError({ message: "Chat not found", code: 404 });

const summaryColumns = {
  id: assistantChats.id,
  organizationId: assistantChats.organizationId,
  organizationName: organizations.name,
  title: assistantChats.title,
  createdAt: assistantChats.createdAt,
  lastMessageAt: assistantChats.lastMessageAt,
  turnStatus: assistantChats.turnStatus,
  contextTokens: assistantChats.contextTokens,
};

type SummaryRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  title: string | null;
  createdAt: Date;
  lastMessageAt: Date;
  turnStatus: string;
  contextTokens: number;
};

const toSummary = (row: SummaryRow): ChatSummary => ({
  id: row.id,
  organizationId: row.organizationId,
  organizationName: row.organizationName,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  lastMessageAt: row.lastMessageAt.toISOString(),
  turnRunning: row.turnStatus === "running",
  closed: closedReason(row),
});

/** The caller's chats, newest activity first, in organizations where the Assistant is available. */
export const listChats = async (userId: string): Promise<ChatSummary[]> => {
  const rows = await db
    .select(summaryColumns)
    .from(assistantChats)
    .innerJoin(organizations, eq(organizations.id, assistantChats.organizationId))
    .where(eq(assistantChats.userId, userId))
    .orderBy(desc(assistantChats.lastMessageAt));
  return rows.filter((row) => isAiFeatureAvailable("assistant", row.organizationId)).map(toSummary);
};

/**
 * Opens a chat in one organization: refused (403 `AI_ORGANIZATION_NOT_ELIGIBLE`)
 * unless the caller has standing there, the Assistant is on and the plan is
 * Enterprise. The same resolver as the OAuth picker.
 */
export const createChat = async (args: {
  userId: string;
  organizationId: string;
}): Promise<ChatSummary> => {
  const eligible = await assertAiEligible({ ...args, feature: "assistant" });
  const id = generateRandomUUID();
  const [row] = await db
    .insert(assistantChats)
    .values({ id, organizationId: args.organizationId, userId: args.userId })
    .returning();
  return toSummary({ ...row!, organizationName: eligible.organizationName });
};

/**
 * The caller's own chat, 404 for anyone else's and while the Assistant is
 * unavailable in its organization (switch off and not on the preview list).
 */
export const getOwnChat = async (
  args: { userId: string; chatId: string },
  tx?: DbTransaction
): Promise<ChatRow & { organizationName: string }> => {
  const [row] = await (tx ?? db)
    .select({ chat: assistantChats, organizationName: organizations.name })
    .from(assistantChats)
    .innerJoin(organizations, eq(organizations.id, assistantChats.organizationId))
    .where(and(eq(assistantChats.id, args.chatId), eq(assistantChats.userId, args.userId)))
    .limit(1);
  if (!row || !isAiFeatureAvailable("assistant", row.chat.organizationId)) throw chatNotFound();
  return { ...row.chat, organizationName: row.organizationName };
};

export const chatSummary = (chat: ChatRow & { organizationName: string }): ChatSummary =>
  toSummary(chat);

export const readDisplayRecord = async (chatId: string): Promise<DisplayMessage[]> => {
  const rows = await db
    .select()
    .from(assistantChatMessages)
    .where(eq(assistantChatMessages.chatId, chatId))
    .orderBy(asc(assistantChatMessages.seq));
  const cards = await cardsOf(chatId);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    text: row.text,
    toolName: row.toolName,
    toolOutcome: row.toolOutcome,
    code: row.code,
    card: (row.kind === "tool" && row.eventId && cards.get(row.eventId)) || null,
    createdAt: row.createdAt.toISOString(),
  }));
};

export const getChatDetail = async (args: {
  userId: string;
  chatId: string;
}): Promise<ChatDetail> => {
  const chat = await getOwnChat(args);
  return { chat: toSummary(chat), messages: await readDisplayRecord(chat.id) };
};

/** Deletes the chat and its display record, then its session; a failed session delete is retried nightly. */
export const deleteChat = async (args: { userId: string; chatId: string }): Promise<void> => {
  const chat = await getOwnChat(args);
  await deleteChatById(chat.id);
};

/** The caller's role in an organization: owner, org admin, or anything else. */
export const roleIn = async (userId: string, organizationId: string): Promise<AssistantRole> => {
  const [owned] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), eq(organizations.ownerUserId, userId)))
    .limit(1);
  if (owned) return "owner";
  return (await isOrganizationAdmin(userId, organizationId)) ? "admin" : "member";
};

/**
 * Every organization the caller has standing in, oldest first, with the
 * shared eligibility answer and what the panel's button rules read: whether
 * the plan includes the Assistant and the caller's role.
 */
export const listAssistantOrganizations = async (
  userId: string
): Promise<AssistantOrganization[]> => {
  const answers = await aiEligibilityForUser({ userId, feature: "assistant" });
  const withChats = new Set(
    (
      await db
        .selectDistinct({ organizationId: assistantChats.organizationId })
        .from(assistantChats)
        .where(eq(assistantChats.userId, userId))
    ).map((row) => row.organizationId)
  );
  const usage = await readWeeklyUsage(
    answers.filter((answer) => answer.eligible).map((answer) => answer.organizationId)
  );
  const result: AssistantOrganization[] = [];
  for (const answer of answers) {
    if (!answer.eligible && answer.reason === "UNAVAILABLE") continue;
    const role = await roleIn(userId, answer.organizationId);
    const week = usage.get(answer.organizationId);
    const seesMoney = role === "owner" || role === "admin";
    result.push({
      organizationId: answer.organizationId,
      organizationName: answer.organizationName,
      eligible: answer.eligible,
      reason: answer.eligible ? null : answer.reason,
      planAllows: isAssistantPlan(await planForOrganization(answer.organizationId)),
      role,
      hasChats: withChats.has(answer.organizationId),
      weeklyLimit: week
        ? {
            percent: Math.min(100, Math.floor((week.usedMicroUsd * 100) / week.limitMicroUsd)),
            reached: week.reached,
            resetsAt: week.resetsAt.toISOString(),
            usedMicroUsd: seesMoney ? week.usedMicroUsd : null,
            limitMicroUsd: seesMoney ? week.limitMicroUsd : null,
          }
        : null,
    });
  }
  return result;
};
