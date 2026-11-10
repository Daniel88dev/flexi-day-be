import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../../middleware/logger.js";
import { asSearchResultBlocks } from "../../../tools/docs/docsTools.js";
import AppError from "../../../utils/appError.js";
import { errorName } from "../../../utils/errorName.js";
import {
  MESSAGE_SCREEN_SCHEMA,
  TOOL_TEXT_SCREEN_INSTRUCTION,
  TOOL_TEXT_SCREEN_SCHEMA,
  messageScreenInput,
  messageScreenSystem,
  toolTextScreenInput,
} from "../screen/screenPrompt.js";
import { assistantUnavailable } from "./anthropicClient.js";
import {
  ProviderRefusedError,
  type AssistantDriver,
  type LiveStream,
  type SessionEvent,
  type SessionUsage,
  type StreamItem,
} from "./types.js";

/**
 * The driver behind `ASSISTANT_DRIVER=managed`: Claude Managed Agents, the
 * only code that talks to it. Events pass through in the API's own shapes; the
 * stream's `event_delta` previews become `text_delta` items. Every API failure
 * is logged by status and type (never its message, which can quote a prompt)
 * and answered with 503 `ASSISTANT_UNAVAILABLE`.
 */

type Raw = Record<string, unknown>;

const isNotFound = (error: unknown) => error instanceof Anthropic.NotFoundError;

const isBillingRefusal = (api: { status: unknown; type: unknown }): boolean =>
  api.status === 402 || api.type === "billing_error";

/**
 * Logs a failed API call by status and type and answers the 503 the caller
 * sees, or `ProviderRefusedError` for a spend limit or credits.
 */
const unavailable = (operation: string, error: unknown): AppError | ProviderRefusedError => {
  if (error instanceof AppError || error instanceof ProviderRefusedError) return error;
  const api = error instanceof Anthropic.APIError ? error : null;
  if (api && isBillingRefusal(api)) return new ProviderRefusedError();
  logger.error("assistant.provider_error", {
    operation,
    status: typeof api?.status === "number" ? api.status : undefined,
    type: api ? String(api.type) : undefined,
    error: errorName(error),
  });
  return assistantUnavailable();
};

const call = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw unavailable(operation, error);
  }
};

/** A logged event, or text from an `event_delta` preview of an `agent.message`. */
const streamItem = (raw: Raw): StreamItem | null => {
  if (raw.type === "event_delta") {
    const delta = raw.delta as { type?: string; content?: { type?: string; text?: unknown } };
    if (delta.type === "content_delta" && delta.content?.type === "text") {
      const text = delta.content.text;
      return { kind: "text_delta", text: typeof text === "string" ? text : "" };
    }
    return null;
  }
  if (typeof raw.id !== "string" || raw.type === "event_start") return null;
  return { kind: "event", event: raw as unknown as SessionEvent };
};

/** The API takes whole cents; round up so the ceiling never sits below the reservation. */
const budgetOf = (microUsd: number) => ({
  type: "limit" as const,
  max_list_cost: {
    amount: String(Math.max(1, Math.ceil(microUsd / 10_000))),
    currency: "USD" as const,
  },
});

const usageOf = (raw: Raw | undefined): SessionUsage => {
  const usage = (raw ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  };
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation: {
      ephemeral_5m_input_tokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      ephemeral_1h_input_tokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    },
  };
};

/**
 * One screen call on the Messages API: thinking off, JSON-schema output, the
 * instruction as a cached system block, no retry (the screen fails closed).
 * Answers the JSON text, or `null` for a refusal, which carries no content.
 */
const screenRequest = async (
  client: Anthropic,
  request: {
    model: string;
    system: string;
    input: string;
    schema: { [key: string]: unknown };
    maxTokens: number;
  },
  signal: AbortSignal
): Promise<{ json: unknown; usage: SessionUsage }> => {
  const message = await client.messages.create(
    {
      model: request.model,
      max_tokens: request.maxTokens,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: request.schema } },
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: request.input }],
    },
    { signal, maxRetries: 0 }
  );
  const usage = usageOf(message.usage as unknown as Raw);
  if (
    usage.cache_creation.ephemeral_5m_input_tokens +
      usage.cache_creation.ephemeral_1h_input_tokens ===
    0
  ) {
    usage.cache_creation.ephemeral_5m_input_tokens = message.usage.cache_creation_input_tokens ?? 0;
  }
  const block = message.content.find((item) => item.type === "text");
  if (message.stop_reason === "refusal" || !block) return { json: null, usage };
  return { json: JSON.parse(block.text) as unknown, usage };
};

/** `read_doc` answers with `search_result` blocks, which turn on citations; any other result is text. */
const searchResultsIn = (text: string) => {
  try {
    return asSearchResultBlocks(JSON.parse(text));
  } catch {
    return null;
  }
};

const toolResult = (toolUseId: string, result: { text: string; isError: boolean }) => ({
  type: "user.custom_tool_result",
  custom_tool_use_id: toolUseId,
  content: (!result.isError && searchResultsIn(result.text)) || [
    { type: "text", text: result.text },
  ],
  is_error: result.isError,
});

export const createManagedDriver = (args: {
  client: Anthropic;
  agentId: string;
  environmentId: string;
  /** The screen's model; the screen runs on the Messages API, outside any session. */
  screenModel: string;
  /** Pins every session to this agent version instead of the one current at creation. */
  agentVersion?: number;
}): AssistantDriver => {
  const { client, agentId, environmentId, screenModel, agentVersion } = args;
  const sessions = client.beta.sessions;

  const send = (sessionId: string, events: Raw[]): Promise<SessionEvent[]> =>
    call("send_events", async () => {
      const sent = await sessions.events.send(sessionId, {
        events: events as unknown as Parameters<typeof sessions.events.send>[1]["events"],
      });
      return (sent.data ?? []) as unknown as SessionEvent[];
    });

  return {
    name: "managed",

    createSession: (input) =>
      call("create_session", async () => {
        // The bare agent id pins the version current right now; the chat keeps it for life.
        const session = await sessions.create({
          agent: agentVersion ? { type: "agent", id: agentId, version: agentVersion } : agentId,
          environment_id: environmentId,
          metadata: { chat_id: input.chatId, organization_id: input.organizationId },
          budget: budgetOf(input.budgetMicroUsd),
        });
        return { sessionId: session.id, agentVersion: session.agent.version };
      }),

    // A message can carry held tool results ahead of it; they go out as `answerToolCall` sends them.
    sendEvents: (sessionId, events) =>
      send(
        sessionId,
        events.map((event) =>
          event.type === "user.custom_tool_result"
            ? toolResult(event.custom_tool_use_id, {
                text: event.content.map((block) => block.text).join(""),
                isError: event.is_error ?? false,
              })
            : event
        )
      ),

    setBudget: (sessionId, budgetMicroUsd) =>
      call("set_budget", async () => {
        await sessions.update(sessionId, { budget: budgetOf(budgetMicroUsd) });
      }),

    interrupt: async (sessionId) => {
      await send(sessionId, [{ type: "user.interrupt" }]);
    },

    listEvents: (sessionId, options) =>
      call("list_events", async () => {
        const events: SessionEvent[] = [];
        for await (const event of sessions.events.list(sessionId, { order: "asc" })) {
          events.push(event as unknown as SessionEvent);
        }
        if (!options?.afterId) return events;
        const index = events.findIndex((event) => event.id === options.afterId);
        return index === -1 ? events : events.slice(index + 1);
      }),

    stream: (sessionId, signal): LiveStream => {
      const queue: StreamItem[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      let failure: unknown = null;
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const nudge = () => {
        wake?.();
        wake = null;
      };
      signal.addEventListener("abort", nudge, { once: true });

      void (async () => {
        try {
          const sse = await sessions.events.stream(
            sessionId,
            { event_deltas: ["agent.message"] },
            { signal }
          );
          markReady();
          for await (const raw of sse) {
            const item = streamItem(raw as unknown as Raw);
            if (!item) continue;
            queue.push(item);
            nudge();
          }
        } catch (error) {
          if (!signal.aborted) failure = error;
        } finally {
          ended = true;
          markReady();
          nudge();
        }
      })();

      return {
        ready,
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const item = queue.shift();
            if (item) {
              yield item;
              continue;
            }
            if (signal.aborted) return;
            if (failure) throw unavailable("stream", failure);
            if (ended) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
    },

    answerToolCall: async (sessionId, toolUseId, result) => {
      const [event] = await send(sessionId, [toolResult(toolUseId, result)]);
      return event!;
    },

    readUsage: (sessionId) =>
      call("read_usage", async () => {
        const session = await sessions.retrieve(sessionId);
        return usageOf(session.usage as unknown as Raw);
      }),

    // A running session is interrupted first, so the delete never lands mid-step.
    deleteSession: (sessionId) =>
      call("delete_session", async () => {
        try {
          const session = await sessions.retrieve(sessionId);
          if ((session.status as string) === "running") {
            await sessions.events.send(sessionId, {
              events: [{ type: "user.interrupt" }] as unknown as Parameters<
                typeof sessions.events.send
              >[1]["events"],
            });
          }
          await sessions.delete(sessionId);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }),

    screen: (input, signal) =>
      call("screen", async () => {
        const { json, usage } = await screenRequest(
          client,
          {
            model: screenModel,
            system: messageScreenSystem(input.articleIndex),
            input: messageScreenInput(input),
            schema: MESSAGE_SCREEN_SCHEMA,
            maxTokens: 64,
          },
          signal
        );
        if (json === null) return { verdict: { refused: true }, usage };
        const verdict = json as { inScope?: unknown; attack?: unknown };
        if (typeof verdict.inScope !== "boolean" || typeof verdict.attack !== "boolean") {
          throw new Error("The screen answered without a verdict");
        }
        return { verdict: { inScope: verdict.inScope, attack: verdict.attack }, usage };
      }),

    screenToolText: (input, signal) =>
      call("screen_tool_text", async () => {
        const { json, usage } = await screenRequest(
          client,
          {
            model: screenModel,
            system: TOOL_TEXT_SCREEN_INSTRUCTION,
            input: toolTextScreenInput(input.values),
            schema: TOOL_TEXT_SCREEN_SCHEMA,
            maxTokens: 64 + 8 * input.values.length,
          },
          signal
        );
        if (json === null) return { verdict: { refused: true }, usage };
        const flagged = (json as { flagged?: unknown }).flagged;
        if (!Array.isArray(flagged) || !flagged.every((index) => Number.isInteger(index))) {
          throw new Error("The screen answered without a list");
        }
        return { verdict: { flagged: flagged as number[] }, usage };
      }),
  };
};
