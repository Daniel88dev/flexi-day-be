import * as Sentry from "@sentry/node";
import {
  assertGroupsInOrganization,
  assertPeopleInOrganization,
} from "../services/aiFeatures/organizationFence.js";
import AppError from "../utils/appError.js";
import { toToolError, toolMessage, type ToolError } from "./toolErrors.js";
import type { Tool, ToolContext } from "./types.js";
import { serializeToolResult } from "./userText.js";

export type ToolOutcome = "ok" | "invalid_arguments" | "read_only" | "refused" | "failed";

export type ToolRun =
  | { ok: true; result: unknown }
  | { ok: false; outcome: Exclude<ToolOutcome, "ok">; error: ToolError };

/** Whether a tool is offered to, and may run for, this access. */
export const isToolAllowed = (tool: Tool, access: ToolContext["access"]): boolean =>
  tool.kind === "read" || access === "write";

const idsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.map(String) : [];

/** The organization fence: every group and person the input names must belong to the organization. */
const fence = async (tool: Tool, ctx: ToolContext, input: Record<string, unknown>) => {
  const groups: string[] = [];
  const people: string[] = [];
  for (const [field, kind] of Object.entries(tool.fence ?? {})) {
    (kind === "group" ? groups : people).push(...idsOf(input[field]));
  }
  await assertGroupsInOrganization(ctx.organizationId, groups);
  await assertPeopleInOrganization(ctx.organizationId, people);
};

const execute = async (tool: Tool, ctx: ToolContext, args: unknown): Promise<ToolRun> => {
  if (!isToolAllowed(tool, ctx.access)) {
    return { ok: false, outcome: "read_only", error: toolMessage("READ_ONLY", ctx.language) };
  }
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    const error = toolMessage("INVALID_ARGUMENTS", ctx.language);
    // Field paths come from the schema; the issue messages may quote the arguments.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    return {
      ok: false,
      outcome: "invalid_arguments",
      error: { ...error, context: { ...error.context, fields } },
    };
  }
  const input = parsed.data;
  try {
    await fence(tool, ctx, input);
    const result = await tool.handler(ctx, input);
    return { ok: true, result: serializeToolResult(result, tool.userText) };
  } catch (error) {
    const refused = error instanceof AppError && error.statusCode < 500;
    return {
      ok: false,
      outcome: refused ? "refused" : "failed",
      error: toToolError(error, ctx.language, tool.name),
    };
  }
};

/**
 * Runs one tool for one adapter: access check, input validation, the
 * organization fence, the handler, then the result serializer or the error
 * mapping. One `gen_ai.execute_tool` span per run, carrying the tool, the
 * channel and the outcome and never the arguments or the result.
 */
export const runTool = (tool: Tool, ctx: ToolContext, args: unknown): Promise<ToolRun> =>
  Sentry.startSpan(
    {
      name: `execute_tool ${tool.name}`,
      op: "gen_ai.execute_tool",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool.name,
        "gen_ai.tool.type": "function",
        "flexiday.channel": ctx.auth.channel,
      },
    },
    async (span) => {
      const run = await execute(tool, ctx, args);
      const outcome: ToolOutcome = run.ok ? "ok" : run.outcome;
      span.setAttribute("flexiday.tool.outcome", outcome);
      if (outcome === "failed") span.setStatus({ code: 2, message: "internal_error" });
      return run;
    }
  );
