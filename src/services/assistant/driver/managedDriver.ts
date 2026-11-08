import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../../middleware/logger.js";
import AppError from "../../../utils/appError.js";
import { errorName } from "../../../utils/errorName.js";
import { assistantUnavailable } from "./anthropicClient.js";
import type {
  AssistantDriver,
  LiveStream,
  SessionEvent,
  SessionUsage,
  StreamItem,
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

/** Logs a failed API call by status and type and answers the 503 the caller sees. */
const unavailable = (operation: string, error: unknown): AppError => {
  if (error instanceof AppError) return error;
  const api = error instanceof Anthropic.APIError ? error : null;
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

export const createManagedDriver = (args: {
  client: Anthropic;
  agentId: string;
  environmentId: string;
}): AssistantDriver => {
  const { client, agentId, environmentId } = args;
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
          agent: agentId,
          environment_id: environmentId,
          metadata: { chat_id: input.chatId, organization_id: input.organizationId },
        });
        return { sessionId: session.id, agentVersion: session.agent.version };
      }),

    sendEvents: (sessionId, events) => send(sessionId, events),

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
      const [event] = await send(sessionId, [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: toolUseId,
          content: [{ type: "text", text: result.text }],
          is_error: result.isError,
        },
      ]);
      return event!;
    },

    readUsage: (sessionId) =>
      call("read_usage", async () => {
        const session = await sessions.retrieve(sessionId);
        return usageOf(session.usage as unknown as Raw);
      }),

    deleteSession: (sessionId) =>
      call("delete_session", async () => {
        try {
          await sessions.delete(sessionId);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }),

    // The screen is T-722's; until then a managed chat sends nothing through it.
    screen: () => Promise.reject(assistantUnavailable()),
  };
};
