import type { AssistantDriver, SessionEvent } from "./driver/types.js";
import { isTurnRunning } from "./turnServices.js";
import { ASSISTANT_NOTICE } from "./types.js";

/** The five events the chat stream speaks. `card` belongs to pending actions (T-724). */
export type ChatStreamEvent = "text" | "tool" | "card" | "error" | "done";

export type ChatStreamSink = (event: ChatStreamEvent, data: object, id?: string) => void;

/** How often a tail checks whether the turn ended without the session saying so (a dead relay). */
const TURN_CHECK_MS = 2_000;

const isTurnEnd = (event: SessionEvent): boolean =>
  (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") ||
  event.type === "session.status_terminated";

/**
 * Projects a session's events onto the chat stream: everything logged after
 * `afterId`, then the live tail, each event at most once (deduped by its id),
 * until the turn ends. Live text goes out as `text` deltas with no id; each
 * finished Assistant message as a `text` with its event id, which replaces
 * the deltas before it. Ends with `done`. A reconnect is the same projection
 * with the last event id the client saw.
 */
export const projectTurn = async (args: {
  driver: AssistantDriver;
  chatId: string;
  sessionId: string | null;
  /**
   * The last event the client has, or a send that answers the turn's first
   * event id: it runs after the live stream opens, so no live text is missed.
   */
  afterId: string | null | (() => Promise<string>);
  signal: AbortSignal;
  sink: ChatStreamSink;
}): Promise<void> => {
  const { driver, sink } = args;
  if (!args.sessionId || !args.afterId) {
    sink("done", {});
    return;
  }
  const tail = new AbortController();
  const stop = () => tail.abort();
  args.signal.addEventListener("abort", stop, { once: true });
  const live = driver.stream(args.sessionId, tail.signal);

  const seen = new Set<string>();
  const toolNames = new Map<string, string>();
  let ended = false;

  const emit = (event: SessionEvent) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    switch (event.type) {
      case "agent.message":
        sink(
          "text",
          { eventId: event.id, text: event.content.map((block) => block.text).join("") },
          event.id
        );
        break;
      case "agent.custom_tool_use":
        toolNames.set(event.id, event.name);
        sink("tool", { eventId: event.id, name: event.name, status: "running" }, event.id);
        break;
      case "user.custom_tool_result":
        sink(
          "tool",
          {
            eventId: event.custom_tool_use_id,
            name: toolNames.get(event.custom_tool_use_id) ?? null,
            status: event.is_error ? "failed" : "done",
          },
          event.id
        );
        break;
      case "session.error":
        sink("error", { code: ASSISTANT_NOTICE.ERROR }, event.id);
        break;
    }
    if (isTurnEnd(event)) ended = true;
  };

  const watchdog = setInterval(() => {
    void isTurnRunning(args.chatId).then((running) => {
      if (!running) stop();
    });
  }, TURN_CHECK_MS);

  try {
    const afterId = typeof args.afterId === "function" ? await args.afterId() : args.afterId;
    for (const event of await driver.listEvents(args.sessionId, { afterId })) {
      emit(event);
    }
    if (!ended && (await isTurnRunning(args.chatId))) {
      for await (const item of live) {
        if (item.kind === "text_delta") sink("text", { delta: item.text });
        else emit(item.event);
        if (ended || tail.signal.aborted) break;
      }
    }
  } finally {
    clearInterval(watchdog);
    args.signal.removeEventListener("abort", stop);
    tail.abort();
  }
  if (args.signal.aborted) return;
  // The relay writes the display record at the same idle; wait for it so a refetch after `done` sees it.
  for (let i = 0; i < 30 && (await isTurnRunning(args.chatId)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  sink("done", {});
};
