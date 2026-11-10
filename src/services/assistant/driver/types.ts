/**
 * The seam between the chat service and whatever runs the model loop. The
 * shapes follow Claude Managed Agents (`docs/spikes/managed-agents.md`) so the
 * managed driver passes the API's events through: event ids, the idle status
 * with its stop reason, and cumulative `session.usage`.
 */

export type TextBlock = { type: "text"; text: string };

/** What the backend sends into a session. `system.message` must be the last event of a send. */
export type SessionInputEvent =
  | { type: "user.message"; content: TextBlock[] }
  | { type: "system.message"; content: TextBlock[] }
  | {
      type: "user.custom_tool_result";
      custom_tool_use_id: string;
      content: TextBlock[];
      is_error?: boolean;
    };

/** Token counts as `session.usage` reports them, cumulative over the session. */
export type SessionUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
};

/** Per model request, from `span.model_request_end`. No cache split, so the meter settles from `SessionUsage`. */
export type ModelUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export type StopReason =
  | { type: "end_turn" }
  /** `event_ids` are the `agent.custom_tool_use` events waiting for a result. */
  | { type: "requires_action"; event_ids: string[] }
  | { type: "budget_reached" }
  /** The model's own refusal; the turn ends with a fixed message and is never retried. */
  | { type: "refusal" };

type Stamped = { id: string; processed_at: string };

/** One event in a session's log. Listing returns these in order; ids are unique per session. */
export type SessionEvent = Stamped &
  (
    | SessionInputEvent
    | { type: "session.status_running" }
    | { type: "span.model_request_start" }
    | {
        type: "span.model_request_end";
        model_request_start_id: string;
        is_error: boolean;
        model_usage: ModelUsage;
      }
    | { type: "agent.message"; content: TextBlock[] }
    | { type: "agent.custom_tool_use"; name: string; input: Record<string, unknown> }
    | { type: "session.usage"; usage: SessionUsage }
    | { type: "session.status_idle"; stop_reason: StopReason }
    | {
        type: "session.error";
        /** `retrying` means the session carries on by itself; only the other two end the step. */
        error: {
          type: string;
          message: string;
          retry_status?: { type: "retrying" | "exhausted" | "terminal" };
        };
      }
    | { type: "session.status_terminated" }
    | { type: "agent.thread_context_compacted" }
    | { type: "user.interrupt" }
  );

export type SessionEventType = SessionEvent["type"];

/**
 * What a live stream yields: every logged event, plus text as the model writes
 * it. `text_delta` is the driver's rendering of the session's `event_deltas`; it
 * has no id, is never listed, and is lost on reconnect.
 */
export type StreamItem =
  { kind: "event"; event: SessionEvent } | { kind: "text_delta"; text: string };

/**
 * A live stream. `ready` settles once the stream is attached (or has failed,
 * which iteration then throws): a send before that could log events nobody sees.
 */
export type LiveStream = AsyncIterable<StreamItem> & { ready: Promise<void> };

/** The screen's verdict on one user message. `refused` is Haiku's own refusal, which counts as an attack. */
export type ScreenVerdict = { inScope: boolean; attack: boolean } | { refused: true };

export type ScreenInput = {
  message: string;
  previousAssistantMessage: string | null;
  language: "en" | "cs";
  /** The help article index, the screen's definition of what is in scope; `null` before a bundle loads. */
  articleIndex: string | null;
};

/** The screen's verdict and what the call used, which the meter settles. */
export type ScreenAnswer = { verdict: ScreenVerdict; usage: SessionUsage };

/** The text people wrote that one model response's tool results carry, in order. */
export type ToolTextScreenInput = { values: string[] };

/**
 * Which of the values look like instructions, by index. `refused` is Haiku's
 * own refusal, which withholds every value like a failed call.
 */
export type ToolTextScreenAnswer = {
  verdict: { flagged: number[] } | { refused: true };
  usage: SessionUsage;
};

/**
 * Anthropic refused for the workspace's spend limit or credits. Every
 * organization is out until the operator fixes billing, and no organization's
 * Weekly limit is charged for it.
 */
export class ProviderRefusedError extends Error {
  constructor() {
    super("The model provider refused: spend limit or credits");
    this.name = "ProviderRefusedError";
  }
}

/** A `session.error` that means the same refusal mid-session. */
export const isProviderRefusal = (error: { type: string }): boolean =>
  error.type === "billing_error";

export type CreatedSession = {
  sessionId: string;
  /** The agent version the session is pinned to; `null` on the fake driver. */
  agentVersion: number | null;
};

export interface AssistantDriver {
  readonly name: "fake" | "managed";
  /** `budgetMicroUsd` is the session's spend ceiling at creation, the meter's backstop. */
  createSession(input: {
    chatId: string;
    organizationId: string;
    budgetMicroUsd: number;
  }): Promise<CreatedSession>;
  /** Replaces the session's spend ceiling; it must stay above what the session has used. */
  setBudget(sessionId: string, budgetMicroUsd: number): Promise<void>;
  /** Stops the session and hands control back, leaving its tool calls unanswered. */
  interrupt(sessionId: string): Promise<void>;
  /** Appends events to the session and answers them with their ids, in order. */
  sendEvents(sessionId: string, events: SessionInputEvent[]): Promise<SessionEvent[]>;
  /** The session's log in order, after `afterId` when given. */
  listEvents(sessionId: string, options?: { afterId?: string }): Promise<SessionEvent[]>;
  /**
   * Live items from now on, until `signal` aborts. Events logged before the
   * stream opened are not replayed; list them first and dedupe by id.
   */
  stream(sessionId: string, signal: AbortSignal): LiveStream;
  /** Answers one `agent.custom_tool_use` event. */
  answerToolCall(
    sessionId: string,
    toolUseId: string,
    result: { text: string; isError: boolean }
  ): Promise<SessionEvent>;
  readUsage(sessionId: string): Promise<SessionUsage>;
  /** Deletes the session; a session that is already gone is not an error. */
  deleteSession(sessionId: string): Promise<void>;
  /** The Haiku screen of a user message, before it reaches the session. Fails on `signal`. */
  screen(input: ScreenInput, signal: AbortSignal): Promise<ScreenAnswer>;
  /** The Haiku screen of the user-written values in one model response's tool results. */
  screenToolText(input: ToolTextScreenInput, signal: AbortSignal): Promise<ToolTextScreenAnswer>;
}
