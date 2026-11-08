import { mcpCallBudget, mcpWriteBudget } from "../middleware/limiter.js";
import { countAiConnectionCall } from "../services/aiConnections/dailyLimits.js";
import type { ToolError } from "../tools/toolErrors.js";
import type { ToolKind, ToolLanguage } from "../tools/types.js";

export type McpLimitCode =
  | "MCP_CALLS_PER_FIVE_MINUTES"
  | "MCP_WRITES_PER_HOUR"
  | "DAILY_AI_CONNECTION_LIMIT"
  | "MEMBER_DAILY_LIMIT";

/** "2026-11-09 00:00 UTC": the same in both languages, readable to a person and a model. */
const utcTime = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const LIMIT_MESSAGES: Record<
  McpLimitCode,
  Record<ToolLanguage, (count: string, resets: string) => string>
> = {
  MCP_CALLS_PER_FIVE_MINUTES: {
    en: (count, resets) =>
      `This app made too many calls to Flexi Day: the limit is ${count} tool calls in 5 minutes for each app and person. It resets at ${resets}.`,
    cs: (count, resets) =>
      `Tato aplikace volala Flexi Day příliš často: limit je ${count} volání nástrojů za 5 minut pro každou aplikaci a osobu. Obnoví se ${resets}.`,
  },
  MCP_WRITES_PER_HOUR: {
    en: (count, resets) =>
      `This app made too many changes: the limit is ${count} changes an hour for each app and person. It resets at ${resets}.`,
    cs: (count, resets) =>
      `Tato aplikace provedla příliš mnoho změn: limit je ${count} změn za hodinu pro každou aplikaci a osobu. Obnoví se ${resets}.`,
  },
  DAILY_AI_CONNECTION_LIMIT: {
    en: (count, resets) =>
      `This organization reached its daily AI connection limit of ${count} calls. It resets at midnight UTC (${resets}).`,
    cs: (count, resets) =>
      `Organizace vyčerpala denní limit AI připojení, ${count} volání. Obnoví se o půlnoci UTC (${resets}).`,
  },
  MEMBER_DAILY_LIMIT: {
    en: (count, resets) =>
      `You reached your member daily limit of ${count} calls in this organization. It resets at midnight UTC (${resets}).`,
    cs: (count, resets) =>
      `Vyčerpali jste denní limit člena, ${count} volání v této organizaci. Obnoví se o půlnoci UTC (${resets}).`,
  },
};

/** A refusal naming the limit and when it resets, in the user's app language. */
export const limitError = (
  code: McpLimitCode,
  limit: number,
  resetsAt: Date,
  language: ToolLanguage
): ToolError => ({
  message: LIMIT_MESSAGES[code][language](
    new Intl.NumberFormat(language).format(limit),
    utcTime(resetsAt)
  ),
  context: { code, limit, resetsAt: resetsAt.toISOString() },
});

/**
 * Spends one `tools/call` against the burst limits (per user and OAuth client,
 * in memory) and then the daily limits (per organization and member, in
 * Postgres). Answers the first limit it hits, or `null` when the call may run.
 * Called only for `tools/call`, so nothing else a client sends counts.
 */
export const spendMcpCall = async (call: {
  userId: string;
  clientId: string;
  organizationId: string;
  kind: ToolKind;
  language: ToolLanguage;
}): Promise<ToolError | null> => {
  const key = `${call.userId}:${call.clientId}`;
  const calls = await mcpCallBudget.hit(key);
  if (!calls.allowed) {
    return limitError(
      "MCP_CALLS_PER_FIVE_MINUTES",
      mcpCallBudget.limit,
      calls.resetAt,
      call.language
    );
  }
  if (call.kind === "write") {
    const writes = await mcpWriteBudget.hit(key);
    if (!writes.allowed) {
      return limitError("MCP_WRITES_PER_HOUR", mcpWriteBudget.limit, writes.resetAt, call.language);
    }
  }
  const daily = await countAiConnectionCall({
    organizationId: call.organizationId,
    userId: call.userId,
  });
  if (daily.counted) return null;
  return limitError(
    daily.limit === "organization" ? "DAILY_AI_CONNECTION_LIMIT" : "MEMBER_DAILY_LIMIT",
    daily.max,
    daily.resetsAt,
    call.language
  );
};
