import type { AuthSession } from "../../middleware/authSession.js";
import { findTool } from "../../tools/registry.js";
import { previewTool, runTool, type ToolOutcome } from "../../tools/runTool.js";
import type { TextAuthor } from "../../tools/textAuthors.js";
import { toolMessage, type ToolError } from "../../tools/toolErrors.js";
import type { ToolContext, ToolLanguage } from "../../tools/types.js";
import { plainUserText } from "../../tools/userText.js";

/** One tool call answered for the session, and the line the display record keeps. */
export type AssistantToolAnswer = {
  kind: "answer";
  text: string;
  isError: boolean;
  outcome: ToolOutcome;
  /** Who wrote the free text in a read's result. */
  authors: TextAuthor[];
};

/** A write whose preview passed its guards: it waits on the user's card. */
export type AssistantToolCard = {
  kind: "card";
  input: Record<string, unknown>;
  /** The `WritePreview`, user-written strings plain. */
  preview: Record<string, unknown>;
};

type CallArgs = {
  auth: AuthSession;
  organizationId: string;
  language: ToolLanguage;
  name: string;
  input: unknown;
};

const errorAnswer = (error: ToolError, outcome: ToolOutcome): AssistantToolAnswer => ({
  kind: "answer",
  text: JSON.stringify({ error }),
  isError: true,
  outcome,
  authors: [],
});

const contextOf = (args: CallArgs): ToolContext => ({
  auth: { ...args.auth, channel: "assistant" },
  organizationId: args.organizationId,
  access: "write",
  language: args.language,
});

/**
 * The Assistant's adapter over the shared tool layer, on channel `assistant`.
 * A read runs at once. A write never runs here: its preview runs the same
 * guards, and a write they allow becomes a card; one they refuse is answered
 * with that refusal.
 */
export const answerAssistantToolCall = async (
  args: CallArgs
): Promise<AssistantToolAnswer | AssistantToolCard> => {
  const context = contextOf(args);
  const tool = findTool(args.name);
  if (!tool) return errorAnswer(toolMessage("UNKNOWN_TOOL", args.language), "refused");
  if (tool.kind === "write") {
    const preview = await previewTool(tool, context, args.input);
    if (!preview.ok) return errorAnswer(preview.error, preview.outcome);
    return {
      kind: "card",
      input: preview.input,
      preview: plainUserText(preview.details) as Record<string, unknown>,
    };
  }
  const run = await runTool(tool, context, args.input);
  if (!run.ok) return errorAnswer(run.error, run.outcome);
  return {
    kind: "answer",
    text: JSON.stringify(run.result),
    isError: false,
    outcome: "ok",
    authors: run.authors,
  };
};

export type ConfirmedWrite =
  { ok: true; text: string; result: Record<string, unknown> } | { ok: false; error: ToolError };

/** Runs a confirmed card's stored arguments with fresh guards. */
export const runConfirmedWrite = async (args: CallArgs): Promise<ConfirmedWrite> => {
  const tool = findTool(args.name);
  if (!tool || tool.kind !== "write") {
    return { ok: false, error: toolMessage("UNKNOWN_TOOL", args.language) };
  }
  const run = await runTool(tool, contextOf(args), args.input);
  if (!run.ok) return { ok: false, error: run.error };
  return {
    ok: true,
    text: JSON.stringify(run.result),
    result: plainUserText(run.result) as Record<string, unknown>,
  };
};
