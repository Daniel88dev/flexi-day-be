import { z } from "zod";
import type { AssistantMessageKind } from "../../db/schema/assistant-schema.js";
import type { AiIneligibleReason } from "../aiFeatures/aiEligibility.js";

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
};

export type DisplayMessage = {
  id: string;
  kind: AssistantMessageKind;
  text: string | null;
  toolName: string | null;
  toolOutcome: string | null;
  code: string | null;
  createdAt: string;
};

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
};

/** Fixed notices the display record carries; the web app holds their words. */
export const ASSISTANT_NOTICE = {
  /** The session failed or the turn timed out. */
  ERROR: "ASSISTANT_ERROR",
} as const;
