import type { z } from "zod";
import type { AuthSession } from "../middleware/authSession.js";

export type ToolKind = "read" | "write";

/** The languages a tool error is written in: the user's app language. */
export type ToolLanguage = "en" | "cs";

/**
 * Who runs a tool, where, and how far. Built by an adapter (MCP, the
 * Assistant) and the same for every tool of one call.
 */
export type ToolContext = {
  /** `auth.channel` is the adapter's: `mcp` or `assistant`. */
  auth: AuthSession;
  /** The grant's or chat's organization. The fence keeps every tool inside it. */
  organizationId: string;
  /** `read` hides and refuses write tools. The Assistant runs with `write`. */
  access: "read" | "write";
  language: ToolLanguage;
};

/** MCP tool annotations; the Assistant ignores them. */
export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * Input fields that name a group or a person. The runner checks each against
 * the organization before the handler runs.
 */
export type FencedFields<Input> = Partial<Record<keyof Input & string, "group" | "person">>;

/** What a write tool shows before anything changes: the confirmation card's content. */
export type ToolPreview = {
  /** Same path syntax as `userText`, over `details`. */
  userText: readonly string[];
  details: unknown;
};

export type ToolDefinition<Schema extends z.ZodObject, Result> = {
  /** `[A-Za-z0-9_.-]`, 1 to 128 characters. */
  name: string;
  description: string;
  input: Schema;
  annotations: ToolAnnotations;
  kind: ToolKind;
  /** Offered and run only on channel `assistant`, never over `/mcp`: approve and reject. */
  assistantOnly?: boolean;
  fence?: FencedFields<z.infer<Schema>>;
  /**
   * Paths into the result whose strings people wrote: `requests[].note`,
   * `person.name`, `names[]`. The serializer wraps each as `{"user_text": "…"}`.
   */
  userText: readonly string[];
  /** Calls only services that take `auth` and run their own guards (the lint fence). */
  handler: (ctx: ToolContext, input: z.infer<Schema>) => Promise<Result>;
  /** Writes only. */
  preview?: (ctx: ToolContext, input: z.infer<Schema>) => Promise<ToolPreview>;
};

/** A tool with its types erased, as the registry and the adapters hold it. */
export type Tool = Omit<ToolDefinition<z.ZodObject, unknown>, "handler" | "preview" | "fence"> & {
  fence?: Record<string, "group" | "person">;
  handler: (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;
  preview?: (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolPreview>;
};

export const defineTool = <Schema extends z.ZodObject, Result>(
  definition: ToolDefinition<Schema, Result>
): Tool => definition as unknown as Tool;
