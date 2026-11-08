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
  | { type: "budget_reached" };

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
    | { type: "session.error"; error: { type: string; message: string } }
    | { type: "session.status_terminated" }
  );

export type SessionEventType = SessionEvent["type"];

/**
 * What a live stream yields: every logged event, plus text as the model writes
 * it. `text_delta` is the driver's rendering of the session's `event_deltas`; it
 * has no id, is never listed, and is lost on reconnect.
 */
export type StreamItem =
  { kind: "event"; event: SessionEvent } | { kind: "text_delta"; text: string };

/** The screen's answer for one user message (T-722 wires it into the turn). */
export type ScreenVerdict = { inScope: boolean; attack: boolean } | { refused: true };

export type ScreenInput = {
  message: string;
  previousAssistantMessage: string | null;
  language: "en" | "cs";
};

export type CreatedSession = {
  sessionId: string;
  /** The agent version the session is pinned to; `null` on the fake driver. */
  agentVersion: number | null;
};

export interface AssistantDriver {
  readonly name: "fake" | "managed";
  createSession(input: { chatId: string; organizationId: string }): Promise<CreatedSession>;
  /** Appends events to the session and answers them with their ids, in order. */
  sendEvents(sessionId: string, events: SessionInputEvent[]): Promise<SessionEvent[]>;
  /** The session's log in order, after `afterId` when given. */
  listEvents(sessionId: string, options?: { afterId?: string }): Promise<SessionEvent[]>;
  /**
   * Live items from now on, until `signal` aborts. Events logged before the
   * stream opened are not replayed; list them first and dedupe by id.
   */
  stream(sessionId: string, signal: AbortSignal): AsyncIterable<StreamItem>;
  /** Answers one `agent.custom_tool_use` event. */
  answerToolCall(
    sessionId: string,
    toolUseId: string,
    result: { text: string; isError: boolean }
  ): Promise<SessionEvent>;
  readUsage(sessionId: string): Promise<SessionUsage>;
  /** Deletes the session; a session that is already gone is not an error. */
  deleteSession(sessionId: string): Promise<void>;
  /** The Haiku screen; unused until T-722. */
  screen(input: ScreenInput): Promise<ScreenVerdict>;
}
