import { z } from "zod";
import type {
  AssistantMessageKind,
  PendingActionStatus,
} from "../../db/schema/assistant-schema.js";
import type { AiIneligibleReason } from "../aiFeatures/aiEligibility.js";
import type { ChatClosedReason } from "./chatLifecycle.js";

export const MESSAGE_MAX_LENGTH = 4000;
export const TITLE_MAX_LENGTH = 80;

export const validateCreateChat = z.object({
  organizationId: z.uuid(),
});

export type ValidatedCreateChat = z.infer<typeof validateCreateChat>;

export const validateSendMessage = z.object({
  text: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
});

export type ValidatedSendMessage = z.infer<typeof validateSendMessage>;

/** Confirm's body: a reject card's reason for the requester, as the user left it. */
export const validateCardConfirm = z
  .object({ reason: z.string().max(1000).nullable().optional() })
  .optional();

export type ValidatedCardConfirm = z.infer<typeof validateCardConfirm>;

/** Anthropic's webhook body once its signature checks; only the event and session ids are read. */
export const validateAnthropicWebhook = z.object({
  id: z.string().min(1).max(200),
  data: z.object({ id: z.string().min(1).max(200), type: z.string().min(1).max(100) }),
});

const costResult = z.object({
  amount: z.string(),
  currency: z.string(),
  cost_type: z.string().nullable(),
  model: z.string().nullable().optional(),
  workspace_id: z.string().nullable().optional(),
});
const costPage = z.object({
  data: z.array(
    z.object({ starting_at: z.string(), ending_at: z.string(), results: z.array(costResult) })
  ),
});
/** The Admin API's cost report the reconcile reads: one page, or an array of pages. */
export const validateAnthropicCostReport = z.union([costPage, z.array(costPage)]);

export const validateStreamQuery = z.object({
  after: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,128}$/)
    .optional(),
});

export type ChatSummary = {
  id: string;
  organizationId: string;
  organizationName: string;
  title: string | null;
  createdAt: string;
  lastMessageAt: string;
  turnRunning: boolean;
  /** Why the chat takes no more messages: the length ceiling or 30 days idle. */
  closed: ChatClosedReason | null;
};

export type DisplayMessage = {
  id: string;
  kind: AssistantMessageKind;
  text: string | null;
  toolName: string | null;
  toolOutcome: string | null;
  code: string | null;
  /** A write's confirmation card, on its tool line (`toolOutcome` `card`). */
  card: PendingCard | null;
  createdAt: string;
};

/**
 * A confirmation card as the panel shows it. Its text comes from the write's
 * `preview` (a `WritePreview`), never from the model.
 */
export type PendingCard = {
  id: string;
  chatId: string;
  /** The `agent.custom_tool_use` event; the stream's `tool` events share it. */
  toolUseId: string;
  tool: string;
  status: PendingActionStatus;
  preview: Record<string, unknown>;
  /** People other than the user whose notes the Assistant read before suggesting it. */
  authorNames: string[];
  /** The write's result once confirmed. */
  result: Record<string, unknown> | null;
  /** Why the last confirm was refused; the card stays open. */
  error: { message: string; code: string | null } | null;
  createdAt: string;
  decidedAt: string | null;
};

/** What confirm and decline answer: the card, and whether the Assistant now writes on. */
export type CardDecision = { card: PendingCard; turnRunning: boolean };

/** The tool line of a write parked as a card. */
export const TOOL_CARD = "card";

/** Confirm or decline of a card that is no longer open. */
export const PENDING_ACTION_SETTLED = "PENDING_ACTION_SETTLED";

export type ChatDetail = { chat: ChatSummary; messages: DisplayMessage[] };

/** The caller's role in an organization, as the panel's button rules read it. */
export type AssistantRole = "owner" | "admin" | "member";

/** One organization in the panel's picker, eligible or not, with what the button rules need. */
export type AssistantOrganization = {
  organizationId: string;
  organizationName: string;
  eligible: boolean;
  reason: AiIneligibleReason | null;
  /** Enterprise or Custom: whether the Assistant comes with the plan at all. */
  planAllows: boolean;
  role: AssistantRole;
  /** The caller has chats here, readable even while the organization can't take new messages. */
  hasChats: boolean;
  /** This week's Usage against the Weekly limit; `null` where the caller can't chat. */
  weeklyLimit: WeeklyLimitState | null;
};

/**
 * The organization's Weekly limit as the panel shows it. "Used" is settled
 * plus reserved. Money is for owners and org admins; members get the percentage.
 */
export type WeeklyLimitState = {
  percent: number;
  /** No turn can start until the reset. */
  reached: boolean;
  resetsAt: string;
  usedMicroUsd: number | null;
  limitMicroUsd: number | null;
};

/** Fixed notices the display record carries; the web app holds their words. */
export const ASSISTANT_NOTICE = {
  /** The session failed or the turn timed out. */
  ERROR: "ASSISTANT_ERROR",
  /** The screen kept the message from the session: off topic or an attack. */
  TOPIC_REFUSAL: "ASSISTANT_TOPIC_REFUSAL",
  /** The model refused; the turn ends and is not retried. */
  MODEL_REFUSAL: "ASSISTANT_MODEL_REFUSAL",
  /** The organization reached its Weekly limit; the turn stopped there. */
  WEEKLY_LIMIT: "ASSISTANT_WEEKLY_LIMIT_REACHED",
  /** The turn used its 10 model calls. */
  STEP_LIMIT: "ASSISTANT_STEP_LIMIT",
  /** Anthropic refused for its spend limit or credits. */
  UNAVAILABLE: "ASSISTANT_UNAVAILABLE",
} as const;

/** The `code` on a user row the screen rejected; the message was never sent. */
export const REJECTED_MESSAGE = "REJECTED";

/** The screen failed or timed out: 503 before the stream opens, nothing written or sent. */
export const SCREEN_FAILED = "ASSISTANT_SCREEN_FAILED";
