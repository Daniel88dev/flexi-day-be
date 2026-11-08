import type { AuthSession } from "../../middleware/authSession.js";
import { findTool } from "../../tools/registry.js";
import { runTool, type ToolOutcome } from "../../tools/runTool.js";
import { toolMessage, type ToolError } from "../../tools/toolErrors.js";
import type { ToolContext, ToolLanguage } from "../../tools/types.js";

/** One tool call answered for the session, and the line the display record keeps. */
export type AssistantToolAnswer = { text: string; isError: boolean; outcome: ToolOutcome };

const WRITES_NOT_YET: Record<ToolLanguage, string> = {
  en: "Changes through the Assistant aren't available yet. Tell the user how to make this change in the app.",
  cs: "Změny přes Asistenta zatím nejsou k dispozici. Řekni uživateli, jak tuto změnu udělat v aplikaci.",
};

const errorAnswer = (error: ToolError, outcome: ToolOutcome): AssistantToolAnswer => ({
  text: JSON.stringify({ error }),
  isError: true,
  outcome,
});

/**
 * The Assistant's adapter over the shared tool layer: reads run at once through
 * `runTool` on channel `assistant`. A write never runs here; T-724 parks it as
 * a pending action in place of the refusal below.
 */
export const answerAssistantToolCall = async (args: {
  auth: AuthSession;
  organizationId: string;
  language: ToolLanguage;
  name: string;
  input: unknown;
}): Promise<AssistantToolAnswer> => {
  const context: ToolContext = {
    auth: { ...args.auth, channel: "assistant" },
    organizationId: args.organizationId,
    access: "write",
    language: args.language,
  };
  const tool = findTool(args.name);
  if (!tool) return errorAnswer(toolMessage("UNKNOWN_TOOL", args.language), "refused");
  if (tool.kind === "write") {
    return errorAnswer(
      { message: WRITES_NOT_YET[args.language], context: { code: "WRITES_NOT_AVAILABLE" } },
      "refused"
    );
  }
  const run = await runTool(tool, context, args.input);
  if (!run.ok) return errorAnswer(run.error, run.outcome);
  return { text: JSON.stringify(run.result), isError: false, outcome: "ok" };
};
