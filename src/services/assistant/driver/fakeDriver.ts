import crypto from "node:crypto";
import { config } from "../../../config.js";
import { costOf, priceFor } from "../meter/prices.js";
import {
  ProviderRefusedError,
  type AssistantDriver,
  type ModelUsage,
  type ScreenInput,
  type ScreenVerdict,
  type SessionEvent,
  type SessionInputEvent,
  type SessionUsage,
  type StopReason,
  type StreamItem,
} from "./types.js";

/**
 * The scripted driver behind `ASSISTANT_DRIVER=fake`: no Anthropic call and no
 * key. Sessions live in memory; one the process no longer knows (after a
 * restart) comes back empty. Each user message runs one scripted model step,
 * which either answers or calls one tool picked by keywords, then answers
 * from that tool's result once it arrives. Tests queue whole steps in `steps`.
 */

type ScreenFailure = "error" | "timeout" | null;

type ToolCall = { tool: string; input: Record<string, unknown> };

type Script = ToolCall | null;

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
  /** The spend ceiling in micro-USD; a step waits on it like Managed Agents does. */
  budgetMicroUsd: number;
};

const sessions = new Map<string, FakeSession>();

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const randomId = (prefix: string) =>
  `${prefix}_01${Array.from(crypto.randomBytes(22), (b) => BASE62[b % 62]).join("")}`;

/** Test and dev knobs. `hold()` parks every session before its next model output until released. */
export const fakeDriverControls = {
  chunkDelayMs: 15,
  stepDelayMs: 120,
  /**
   * Scripted model steps, taken first one per step: the tool calls each step
   * makes, all in one response. A step with no queued entry answers or picks
   * a tool by keywords.
   */
  steps: [] as ToolCall[][],
  /** Text a tool step writes before its tool call, as a model often does. */
  leadText: null as string | null,
  /**
   * Anthropic refusing for the workspace's spend limit or credits: `call`
   * throws from every driver call, `session` fails the next model step with a
   * `billing_error`.
   */
  providerRefusal: null as "call" | "session" | null,
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
    this.steps = [];
    this.leadText = null;
    this.providerRefusal = null;
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
      budgetMicroUsd: Number.MAX_SAFE_INTEGER,
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

/** The next weekday after `today`, for "book a day off" by hand. */
const nextWeekday = (today: Date) => {
  const day = new Date(today.getTime() + 86_400_000);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setTime(day.getTime() + 86_400_000);
  return isoDay(day);
};

/** Picks the tool a message asks for, by keywords in English or Czech. */
export const scriptFor = (message: string, today = new Date()): Script => {
  const text = message.toLowerCase();
  const year = today.getUTCFullYear();
  if (/clock (me )?in\b|příchod/.test(text)) return { tool: "clock_in", input: {} };
  if (/clock (me )?out\b|odchod/.test(text)) return { tool: "clock_out", input: {} };
  if (/\bbook\b|day off|zarezervuj|vezmi.*volno/.test(text)) {
    // "book 2026-11-12 off" books that day; otherwise the next weekday.
    const day = /\b\d{4}-\d{2}-\d{2}\b/.exec(text)?.[0] ?? nextWeekday(today);
    return { tool: "create_request", input: { from: day, to: day } };
  }
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
    done: "Done. The change is made.",
    left: "Okay, I left everything as it was.",
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
    done: "Hotovo, změna je provedená.",
    left: "Dobře, nechal jsem všechno, jak to bylo.",
  },
};

const plain = (value: unknown): string =>
  typeof value === "object" && value !== null && "user_text" in value
    ? String(value.user_text)
    : String(value);

const WRITES = new Set(["create_request", "cancel_my_request", "clock_in", "clock_out"]);

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
  if (parsed.outcome === "declined" || parsed.outcome === "not_taken") return copy.left;
  if (WRITES.has(result.name)) return copy.done;
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
const listCost = (usage: SessionUsage): number =>
  costOf(priceFor(config.assistant.model, new Date()), {
    inputTokens: usage.input_tokens,
    cacheWrite5mTokens: usage.cache_creation.ephemeral_5m_input_tokens,
    cacheWrite1hTokens: usage.cache_creation.ephemeral_1h_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
  });

const runStep = async (
  session: FakeSession,
  input: { calls: ToolCall[] | null; inputChars: number }
) => {
  if (listCost(session.usage) >= session.budgetMicroUsd) {
    log(session, { type: "session.status_idle", stop_reason: { type: "budget_reached" } });
    return;
  }
  log(session, { type: "session.status_running" });
  if (fakeDriverControls.providerRefusal === "session") {
    log(session, {
      type: "session.error",
      error: { type: "billing_error", message: "Spend limit reached" },
    });
    log(session, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
    return;
  }
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
  } else if (input.calls && input.calls.length > 0) {
    output = JSON.stringify(input.calls);
    session.results = [];
    const lead = fakeDriverControls.leadText;
    if (lead) {
      await emitText(session, lead);
      log(session, { type: "agent.message", content: [{ type: "text", text: lead }] });
      output += lead;
    }
    const ids: string[] = [];
    for (const script of input.calls) {
      const call = log(session, {
        type: "agent.custom_tool_use",
        name: script.tool,
        input: script.input,
      });
      session.pending.set(call.id, script.tool);
      ids.push(call.id);
    }
    stop = { type: "requires_action", event_ids: ids };
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

const run = (session: FakeSession, input: { calls: ToolCall[] | null; inputChars: number }) => {
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

  for (const event of events) {
    if (event.type !== "user.custom_tool_result") continue;
    const name = session.pending.get(event.custom_tool_use_id);
    if (!name) continue;
    session.pending.delete(event.custom_tool_use_id);
    session.results.push({ name, text: textOf(event), isError: event.is_error ?? false });
  }
  if (user) {
    // Results that arrive with a new message are history; the step answers the message.
    session.results = [];
    const message = textOf(user);
    const script = scriptFor(message);
    run(session, {
      calls: fakeDriverControls.steps.shift() ?? (script ? [script] : null),
      inputChars: message.length,
    });
    return logged;
  }
  if (session.pending.size === 0 && session.results.length > 0) {
    run(session, {
      calls: fakeDriverControls.steps.shift() ?? null,
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

const refusedCall = (): Promise<never> | null =>
  fakeDriverControls.providerRefusal === "call" ? Promise.reject(new ProviderRefusedError()) : null;

export const fakeDriver: AssistantDriver = {
  name: "fake",

  createSession(input) {
    const refused = refusedCall();
    if (refused) return refused;
    const sessionId = randomId("sesn");
    sessionOf(sessionId).budgetMicroUsd = input.budgetMicroUsd;
    return Promise.resolve({ sessionId, agentVersion: null });
  },

  setBudget(sessionId, budgetMicroUsd) {
    sessionOf(sessionId).budgetMicroUsd = budgetMicroUsd;
    return Promise.resolve();
  },

  interrupt(sessionId) {
    const session = sessionOf(sessionId);
    session.pending.clear();
    session.results = [];
    log(session, { type: "user.interrupt" });
    log(session, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
    return Promise.resolve();
  },

  sendEvents(sessionId, events) {
    return refusedCall() ?? Promise.resolve(ingest(sessionOf(sessionId), events));
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
    const refused = refusedCall();
    if (refused) return refused;
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
    if (fakeDriverControls.providerRefusal === "call") {
      return Promise.reject(new ProviderRefusedError());
    }
    return screenCall(fakeDriverControls.screenFailure, signal, () => {
      const verdict: ScreenVerdict = SCREEN_REFUSAL.test(input.message)
        ? { refused: true }
        : { inScope: !OFF_TOPIC.test(input.message), attack: ATTACK.test(input.message) };
      const chars = input.message.length + (input.previousAssistantMessage?.length ?? 0);
      return { verdict, usage: screenUsage(chars) };
    });
  },

  screenToolText(input, signal) {
    if (fakeDriverControls.providerRefusal === "call") {
      return Promise.reject(new ProviderRefusedError());
    }
    return screenCall(fakeDriverControls.toolTextScreenFailure, signal, () => ({
      verdict: {
        flagged: input.values.flatMap((value, index) => (ATTACK.test(value) ? [index] : [])),
      },
      usage: screenUsage(input.values.join("").length),
    }));
  },
};
