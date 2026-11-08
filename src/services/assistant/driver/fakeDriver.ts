import crypto from "node:crypto";
import type {
  AssistantDriver,
  ModelUsage,
  ScreenInput,
  ScreenVerdict,
  SessionEvent,
  SessionInputEvent,
  SessionUsage,
  StopReason,
  StreamItem,
} from "./types.js";

/**
 * The scripted driver behind `ASSISTANT_DRIVER=fake`: no Anthropic call and no
 * key. Sessions live in memory; one the process no longer knows (after a
 * restart) comes back empty. Each user message runs one scripted model step,
 * which either answers or calls one read tool picked by keywords, then answers
 * from that tool's result once it arrives.
 */

type ScreenFailure = "error" | "timeout" | null;

type Script = { tool: string; input: Record<string, unknown> } | null;

type FakeSession = {
  events: SessionEvent[];
  usage: SessionUsage;
  listeners: Set<(item: StreamItem) => void>;
  language: "en" | "cs";
  /** Tool calls waiting for a result, by event id. */
  pending: Map<string, string>;
  /** Results received for the current step, by tool name. */
  results: { name: string; text: string; isError: boolean }[];
  /** Model requests so far; the first one writes the prompt cache. */
  requests: number;
};

const sessions = new Map<string, FakeSession>();

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const randomId = (prefix: string) =>
  `${prefix}_01${Array.from(crypto.randomBytes(22), (b) => BASE62[b % 62]).join("")}`;

/** Test and dev knobs. `hold()` parks every session before its next model output until released. */
export const fakeDriverControls = {
  chunkDelayMs: 15,
  stepDelayMs: 120,
  gate: null as Promise<void> | null,
  release: null as (() => void) | null,
  /** Fails every message screen: `error` at once, `timeout` by never answering until aborted. */
  screenFailure: null as ScreenFailure,
  /** The same for the screen of tool results. */
  toolTextScreenFailure: null as ScreenFailure,
  /** The next model step ends with the model's own refusal instead of an answer. */
  modelRefusal: false,
  /** Every message screen input, in order. */
  screened: [] as ScreenInput[],
  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const releaseThis = () => {
      if (this.release === releaseThis) {
        this.gate = null;
        this.release = null;
      }
      release();
    };
    this.release = releaseThis;
    return releaseThis;
  },
  /** Every event the fake has logged for a session, for tests that count them. */
  events(sessionId: string): SessionEvent[] {
    return sessions.get(sessionId)?.events ?? [];
  },
  reset(): void {
    this.release?.();
    sessions.clear();
    this.screenFailure = null;
    this.toolTextScreenFailure = null;
    this.modelRefusal = false;
    this.screened = [];
  },
};

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const emptyUsage = (): SessionUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
});

const sessionOf = (sessionId: string): FakeSession => {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      events: [],
      usage: emptyUsage(),
      listeners: new Set(),
      language: "en",
      pending: new Map(),
      results: [],
      requests: 0,
    };
    sessions.set(sessionId, session);
  }
  return session;
};

const log = (session: FakeSession, event: Record<string, unknown>): SessionEvent => {
  const logged = {
    id: randomId("sevt"),
    processed_at: new Date().toISOString(),
    ...event,
  } as SessionEvent;
  session.events.push(logged);
  for (const listener of session.listeners) listener({ kind: "event", event: logged });
  return logged;
};

const textOf = (event: { content: { text: string }[] }) =>
  event.content.map((c) => c.text).join("");

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Picks the tool a message asks for, by keywords in English or Czech. */
export const scriptFor = (message: string, today = new Date()): Script => {
  const text = message.toLowerCase();
  const year = today.getUTCFullYear();
  if (/balance|left|zůst|zbýv|kolik.*dn/.test(text)) {
    return { tool: "get_my_balances", input: {} };
  }
  if (/away|out|off next|pryč|nepřítom|chybí/.test(text)) {
    const end = new Date(today.getTime() + 6 * 86_400_000);
    return { tool: "list_who_is_away", input: { from: isoDay(today), to: isoDay(end) } };
  }
  if (/request|žádost/.test(text)) {
    return { tool: "list_my_requests", input: { from: `${year}-01-01`, to: `${year}-12-31` } };
  }
  return null;
};

const COPY = {
  en: {
    hello:
      "I'm the Assistant, running on the fake driver. Ask me how many days you have left, who's away this week, or about your requests.",
    failed: (message: string) => `I couldn't look that up. ${message}`,
    balances: "Here's what you have left this year:",
    noBalances: "You have no allowance set up in this organization yet.",
    away: (n: number) => (n === 0 ? "Nobody is away this week." : "Away this week:"),
    requests: (n: number) =>
      n === 0 ? "You have no requests this year." : `You have ${n.toString()} requests this year.`,
    days: "days",
  },
  cs: {
    hello:
      "Jsem Asistent a běžím na testovacím ovladači. Zeptej se, kolik ti zbývá dní, kdo je tento týden pryč, nebo na své žádosti.",
    failed: (message: string) => `Tohle se mi nepodařilo zjistit. ${message}`,
    balances: "Letos ti zbývá:",
    noBalances: "V této organizaci zatím nemáš nastavený žádný nárok.",
    away: (n: number) => (n === 0 ? "Tento týden nikdo pryč není." : "Tento týden jsou pryč:"),
    requests: (n: number) =>
      n === 0 ? "Letos nemáš žádné žádosti." : `Letos máš ${n.toString()} žádostí.`,
    days: "dní",
  },
};

const plain = (value: unknown): string =>
  typeof value === "object" && value !== null && "user_text" in value
    ? String(value.user_text)
    : String(value);

/** The scripted answer to one tool result, written from the result like a model would. */
export const answerFor = (
  language: "en" | "cs",
  result: { name: string; text: string; isError: boolean } | null
): string => {
  const copy = COPY[language];
  if (!result) return copy.hello;
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  if (result.isError) {
    const error = (parsed.error ?? parsed) as { message?: string };
    return copy.failed(error.message ?? "");
  }
  if (result.name === "get_my_balances") {
    const buckets = (parsed.buckets ?? []) as {
      type: string;
      allocated: number;
      remaining: number;
    }[];
    const rows = buckets.filter((bucket) => bucket.allocated > 0);
    if (rows.length === 0) return copy.noBalances;
    return [
      copy.balances,
      "",
      ...rows.map(
        (b) => `- **${b.type}**: ${b.remaining.toString()} / ${b.allocated.toString()} ${copy.days}`
      ),
    ].join("\n");
  }
  if (result.name === "list_who_is_away") {
    const absences = (parsed.absences ?? []) as {
      personName: unknown;
      type: string;
      firstDay: string;
      lastDay: string;
    }[];
    return [
      copy.away(absences.length),
      ...(absences.length > 0 ? [""] : []),
      ...absences.map(
        (a) => `- **${plain(a.personName)}**, ${a.type}, ${a.firstDay} – ${a.lastDay}`
      ),
    ].join("\n");
  }
  const requests = (parsed.requests ?? []) as unknown[];
  return copy.requests(requests.length);
};

/** Token counts shaped like the spike's: the first request writes the prompt cache, later ones read it. */
const usageFor = (session: FakeSession, inputChars: number, output: string): ModelUsage => {
  const prefix = 7713;
  const fresh = Math.ceil(inputChars / 4) + 20;
  const usage: ModelUsage =
    session.requests === 0
      ? {
          input_tokens: 4,
          cache_creation_input_tokens: prefix + fresh,
          cache_read_input_tokens: 0,
          output_tokens: Math.ceil(output.length / 4) + 30,
        }
      : {
          input_tokens: 4,
          cache_creation_input_tokens: fresh,
          cache_read_input_tokens: prefix + session.requests * 150,
          output_tokens: Math.ceil(output.length / 4) + 30,
        };
  session.requests += 1;
  return usage;
};

const addUsage = (session: FakeSession, step: ModelUsage) => {
  session.usage = {
    input_tokens: session.usage.input_tokens + step.input_tokens,
    output_tokens: session.usage.output_tokens + step.output_tokens,
    cache_read_input_tokens: session.usage.cache_read_input_tokens + step.cache_read_input_tokens,
    cache_creation: {
      ephemeral_5m_input_tokens:
        session.usage.cache_creation.ephemeral_5m_input_tokens + step.cache_creation_input_tokens,
      ephemeral_1h_input_tokens: 0,
    },
  };
};

const emitText = async (session: FakeSession, text: string) => {
  for (let i = 0; i < text.length; i += 12) {
    const delta = text.slice(i, i + 12);
    for (const listener of session.listeners) listener({ kind: "text_delta", text: delta });
    await sleep(fakeDriverControls.chunkDelayMs);
  }
};

/** One model request: tool call or text, then usage and idle. */
const runStep = async (session: FakeSession, input: { script: Script; inputChars: number }) => {
  log(session, { type: "session.status_running" });
  const start = log(session, { type: "span.model_request_start" });
  await sleep(fakeDriverControls.stepDelayMs);
  if (fakeDriverControls.gate) await fakeDriverControls.gate;

  let stop: StopReason;
  let output: string;
  if (fakeDriverControls.modelRefusal) {
    fakeDriverControls.modelRefusal = false;
    output = "";
    session.results = [];
    stop = { type: "refusal" };
  } else if (input.script) {
    output = JSON.stringify(input.script.input);
    const call = log(session, {
      type: "agent.custom_tool_use",
      name: input.script.tool,
      input: input.script.input,
    });
    session.pending.set(call.id, input.script.tool);
    stop = { type: "requires_action", event_ids: [call.id] };
  } else {
    const [result] = session.results;
    output = answerFor(session.language, result ?? null);
    await emitText(session, output);
    log(session, { type: "agent.message", content: [{ type: "text", text: output }] });
    session.results = [];
    stop = { type: "end_turn" };
  }

  const usage = usageFor(session, input.inputChars, output);
  addUsage(session, usage);
  log(session, {
    type: "span.model_request_end",
    model_request_start_id: start.id,
    is_error: false,
    model_usage: usage,
  });
  log(session, { type: "session.usage", usage: session.usage });
  log(session, { type: "session.status_idle", stop_reason: stop });
};

const run = (session: FakeSession, input: { script: Script; inputChars: number }) => {
  void runStep(session, input).catch((error: unknown) => {
    log(session, {
      type: "session.error",
      error: { type: "fake_error", message: error instanceof Error ? error.name : "unknown" },
    });
    log(session, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
  });
};

const ingest = (session: FakeSession, events: SessionInputEvent[]): SessionEvent[] => {
  const logged = events.map((event) => log(session, event as unknown as Record<string, unknown>));
  const user = events.find((event) => event.type === "user.message");
  const system = events.find((event) => event.type === "system.message");
  if (system && /language:\s*(czech|cs)/i.test(textOf(system))) session.language = "cs";
  if (system && /language:\s*(english|en)\b/i.test(textOf(system))) session.language = "en";

  if (user) {
    const message = textOf(user);
    run(session, { script: scriptFor(message), inputChars: message.length });
    return logged;
  }
  for (const event of events) {
    if (event.type !== "user.custom_tool_result") continue;
    const name = session.pending.get(event.custom_tool_use_id);
    if (!name) continue;
    session.pending.delete(event.custom_tool_use_id);
    session.results.push({ name, text: textOf(event), isError: event.is_error ?? false });
  }
  if (session.pending.size === 0 && session.results.length > 0) {
    run(session, {
      script: null,
      inputChars: session.results.reduce((sum, r) => sum + r.text.length, 0),
    });
  }
  return logged;
};

const ATTACK = /ignore (all |your |the |previous )*(instructions|rules)|ignoruj/i;
/** Off-topic in the fake screen's eyes, so the refusal can be tried by hand too. */
const OFF_TOPIC = /\b(recipe|weather|capital of|python)\b|recept|počasí/i;
/** Haiku's own refusal, as the spike saw it on an encoded attack. */
const SCREEN_REFUSAL = /base64|aWdub3Jl/i;

const screenUsage = (chars: number): SessionUsage => ({
  input_tokens: Math.ceil(chars / 4) + 20,
  output_tokens: 12,
  cache_read_input_tokens: 2400,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
});

/** Answers a screen call the way the controls say: a verdict, an error, or nothing until aborted. */
const screenCall = <T>(
  failure: ScreenFailure,
  signal: AbortSignal,
  answer: () => T
): Promise<T> => {
  if (failure === "error") {
    return Promise.reject(new Error("fake screen failure"));
  }
  if (failure === "timeout") {
    return new Promise<T>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("fake screen aborted")), {
        once: true,
      });
    });
  }
  return Promise.resolve(answer());
};

export const fakeDriver: AssistantDriver = {
  name: "fake",

  createSession() {
    const sessionId = randomId("sesn");
    sessionOf(sessionId);
    return Promise.resolve({ sessionId, agentVersion: null });
  },

  sendEvents(sessionId, events) {
    return Promise.resolve(ingest(sessionOf(sessionId), events));
  },

  listEvents(sessionId, options) {
    const events = sessionOf(sessionId).events;
    if (!options?.afterId) return Promise.resolve([...events]);
    const index = events.findIndex((event) => event.id === options.afterId);
    return Promise.resolve(index === -1 ? [...events] : events.slice(index + 1));
  },

  stream(sessionId, signal) {
    const session = sessionOf(sessionId);
    const queue: StreamItem[] = [];
    let wake: (() => void) | null = null;
    const listener = (item: StreamItem) => {
      queue.push(item);
      wake?.();
    };
    session.listeners.add(listener);
    const stop = () => {
      session.listeners.delete(listener);
      wake?.();
    };
    signal.addEventListener("abort", stop, { once: true });

    return {
      ready: Promise.resolve(),
      async *[Symbol.asyncIterator]() {
        try {
          while (!signal.aborted) {
            const item = queue.shift();
            if (item) {
              yield item;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
          }
        } finally {
          stop();
        }
      },
    };
  },

  answerToolCall(sessionId, toolUseId, result) {
    const [event] = ingest(sessionOf(sessionId), [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: toolUseId,
        content: [{ type: "text", text: result.text }],
        is_error: result.isError,
      },
    ]);
    return Promise.resolve(event!);
  },

  readUsage(sessionId) {
    return Promise.resolve(sessionOf(sessionId).usage);
  },

  deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (!session) return Promise.resolve();
    const terminated = {
      id: randomId("sevt"),
      processed_at: new Date().toISOString(),
      type: "session.status_terminated",
    } as SessionEvent;
    for (const listener of session.listeners) listener({ kind: "event", event: terminated });
    session.listeners.clear();
    return Promise.resolve();
  },

  screen(input, signal) {
    fakeDriverControls.screened.push(input);
    return screenCall(fakeDriverControls.screenFailure, signal, () => {
      const verdict: ScreenVerdict = SCREEN_REFUSAL.test(input.message)
        ? { refused: true }
        : { inScope: !OFF_TOPIC.test(input.message), attack: ATTACK.test(input.message) };
      const chars = input.message.length + (input.previousAssistantMessage?.length ?? 0);
      return { verdict, usage: screenUsage(chars) };
    });
  },

  screenToolText(input, signal) {
    return screenCall(fakeDriverControls.toolTextScreenFailure, signal, () => ({
      verdict: {
        flagged: input.values.flatMap((value, index) => (ATTACK.test(value) ? [index] : [])),
      },
      usage: screenUsage(input.values.join("").length),
    }));
  },
};
