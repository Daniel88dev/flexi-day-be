import * as Sentry from "@sentry/node";
import {
  assertGroupsInOrganization,
  assertPeopleInOrganization,
} from "../services/aiFeatures/organizationFence.js";
import AppError from "../utils/appError.js";
import { textAuthorsOf, type TextAuthor } from "./textAuthors.js";
import { toToolError, toolMessage, type ToolError } from "./toolErrors.js";
import type { Tool, ToolContext } from "./types.js";
import { serializeToolResult } from "./userText.js";

export type ToolOutcome = "ok" | "invalid_arguments" | "read_only" | "refused" | "failed";

export type ToolRun =
  | {
      ok: true;
      result: unknown;
      /** Who wrote the free text in the result, as the handler declared it. */
      authors: TextAuthor[];
    }
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

type Refusal = Extract<ToolRun, { ok: false }>;

/** The checks before a handler or a preview: access, then the input schema. */
const admit = (
  tool: Tool,
  ctx: ToolContext,
  args: unknown
): { ok: true; input: Record<string, unknown> } | Refusal => {
  if (tool.assistantOnly && ctx.auth.channel !== "assistant") {
    return { ok: false, outcome: "refused", error: toolMessage("UNKNOWN_TOOL", ctx.language) };
  }
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
  return { ok: true, input: parsed.data };
};

const refusalOf = (error: unknown, tool: Tool, ctx: ToolContext): Refusal => {
  const refused = error instanceof AppError && error.statusCode < 500;
  return {
    ok: false,
    outcome: refused ? "refused" : "failed",
    error: toToolError(error, ctx.language, tool.name),
  };
};

const execute = async (tool: Tool, ctx: ToolContext, args: unknown): Promise<ToolRun> => {
  const admitted = admit(tool, ctx, args);
  if (!admitted.ok) return admitted;
  try {
    await fence(tool, ctx, admitted.input);
    const result = await tool.handler(ctx, admitted.input);
    return {
      ok: true,
      result: serializeToolResult(result, tool.userText),
      authors: textAuthorsOf(result),
    };
  } catch (error) {
    return refusalOf(error, tool, ctx);
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

export type ToolPreviewRun =
  | {
      ok: true;
      /** The validated arguments: what a confirmed write runs with. */
      input: Record<string, unknown>;
      /** The tool's `WritePreview`, user-written strings wrapped. */
      details: unknown;
    }
  | Refusal;

/**
 * A write tool's dry run: the same access check, input validation and
 * organization fence as {@link runTool}, then the tool's `preview`, which runs
 * the service's guards and writes nothing. A guard's refusal comes back as the
 * write would answer it. A read tool has no preview and is refused as `failed`.
 */
export const previewTool = async (
  tool: Tool,
  ctx: ToolContext,
  args: unknown
): Promise<ToolPreviewRun> => {
  const admitted = admit(tool, ctx, args);
  if (!admitted.ok) return admitted;
  try {
    if (!tool.preview) throw new Error(`Tool ${tool.name} has no preview`);
    await fence(tool, ctx, admitted.input);
    const preview = await tool.preview(ctx, admitted.input);
    return {
      ok: true,
      input: admitted.input,
      details: serializeToolResult(preview.details, preview.userText),
    };
  } catch (error) {
    return refusalOf(error, tool, ctx);
  }
};
