import Anthropic from "@anthropic-ai/sdk";

/**
 * An in-memory stand-in for the Managed Agents REST API, served through the
 * SDK's `fetch` option. Shapes follow what the T-711 spike recorded
 * (`docs/spikes/managed-agents.md`); only the endpoints the driver and the
 * agent sync call are here.
 */

type Json = Record<string, unknown>;

type FakeAgent = Json & { id: string; name: string; version: number; archived_at: string | null };
type FakeSession = {
  id: string;
  agent: Json;
  events: Json[];
  streams: Set<ReadableStreamDefaultController<Uint8Array>>;
  usage: Json;
  budget: Json | null;
  /** `running` refuses a delete until a `user.interrupt` idles it (modelled, not verified live). */
  status: "idle" | "running";
};

const encoder = new TextEncoder();
let counter = 0;
const nextId = (prefix: string) => `${prefix}_01Fake${String(++counter).padStart(8, "0")}`;
const now = () => new Date().toISOString();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const apiError = (status: number, type: string, message: string) =>
  json(status, { type: "error", error: { type, message } });

/** A page of `size` items with a numeric cursor, like the API's `next_page`. */
const page = (items: unknown[], url: URL, size: number) => {
  const start = Number(url.searchParams.get("page") ?? "0");
  const slice = items.slice(start, start + size);
  const next = start + size < items.length ? String(start + size) : null;
  return json(200, { data: slice, next_page: next });
};

export const createFakeManagedAgentsApi = (options: { pageSize?: number } = {}) => {
  const pageSize = options.pageSize ?? 2;
  const agents = new Map<string, FakeAgent>();
  /** Every version an agent had, for "which version does the session run". */
  const agentVersions = new Map<string, FakeAgent[]>();
  const environments = new Map<string, Json & { id: string; name: string }>();
  const sessions = new Map<string, FakeSession>();
  const calls: { method: string; path: string; body: Json | null }[] = [];
  /** Makes the next agent update answer 409, as a racing writer would. */
  const state = {
    conflictNextUpdate: false,
    /** Answer every session call as a workspace out of credits would. */
    billingRefusal: false,
  };
  /** Canned Messages API answers for the screen, taken in order; none left answers 500. */
  const messageReplies: Json[] = [];

  const logEvent = (session: FakeSession, event: Json): Json => {
    const logged = { id: nextId("sevt"), processed_at: now(), ...event };
    session.events.push(logged);
    for (const controller of session.streams) {
      controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(logged)}\n\n`));
    }
    return logged;
  };

  const route = (method: string, url: URL, body: Json | null): Response => {
    const path = url.pathname;
    if (path === "/v1/messages" && method === "POST") {
      const reply = messageReplies.shift();
      return reply ? json(200, reply) : apiError(500, "api_error", "no canned message");
    }
    let match: RegExpMatchArray | null;
    if (state.billingRefusal && path.startsWith("/v1/sessions")) {
      return apiError(402, "billing_error", "Your credit balance is too low");
    }

    if (method === "GET" && path === "/v1/agents") {
      const all = [...agents.values()];
      const visible =
        url.searchParams.get("include_archived") === "true"
          ? all
          : all.filter((agent) => !agent.archived_at);
      return page(visible, url, pageSize);
    }
    if (method === "POST" && path === "/v1/agents") {
      if ("max_tokens" in (body ?? {})) {
        return apiError(400, "invalid_request_error", 'unknown field "max_tokens"');
      }
      const agent: FakeAgent = {
        type: "agent",
        metadata: {},
        mcp_servers: [],
        skills: [],
        ...body,
        id: nextId("agent"),
        name: String(body?.name),
        version: 1,
        archived_at: null,
        created_at: now(),
      };
      agents.set(agent.id, agent);
      agentVersions.set(agent.id, [structuredClone(agent)]);
      return json(200, agent);
    }
    if ((match = /^\/v1\/agents\/([^/]+)$/.exec(path))) {
      const agent = agents.get(match[1]!);
      if (!agent) return apiError(404, "not_found_error", "agent not found");
      if (method === "GET") return json(200, agent);
      if (method === "POST") {
        if (state.conflictNextUpdate || (body?.version && body.version !== agent.version)) {
          state.conflictNextUpdate = false;
          return apiError(409, "conflict_error", "agent version does not match");
        }
        const { version: _expected, metadata, ...fields } = body ?? {};
        Object.assign(agent, fields, {
          metadata: { ...(agent.metadata as Json), ...(metadata as Json) },
          version: agent.version + 1,
        });
        agentVersions.get(agent.id)!.push(structuredClone(agent));
        return json(200, agent);
      }
    }
    if ((match = /^\/v1\/agents\/([^/]+)\/archive$/.exec(path)) && method === "POST") {
      const agent = agents.get(match[1]!);
      if (!agent) return apiError(404, "not_found_error", "agent not found");
      agent.archived_at = now();
      return json(200, agent);
    }

    if (method === "GET" && path === "/v1/environments") {
      return page([...environments.values()], url, pageSize);
    }
    if (method === "POST" && path === "/v1/environments") {
      const environment = {
        type: "environment",
        ...body,
        id: nextId("env"),
        name: String(body?.name),
        state: "active",
      };
      environments.set(environment.id, environment);
      return json(200, environment);
    }
    if ((match = /^\/v1\/environments\/([^/]+)$/.exec(path)) && method === "DELETE") {
      environments.delete(match[1]!);
      return json(200, { id: match[1], type: "environment_deleted" });
    }

    if (method === "POST" && path === "/v1/sessions") {
      const requested = body?.agent as string | { id: string; version?: number } | undefined;
      const current = agents.get(typeof requested === "object" ? requested.id : String(requested));
      const agent =
        typeof requested === "object" && requested.version && current
          ? agentVersions.get(current.id)?.find((v) => v.version === requested.version)
          : current;
      if (!agent) return apiError(404, "not_found_error", "agent not found");
      if (!environments.has(String(body?.environment_id))) {
        return apiError(404, "not_found_error", "environment not found");
      }
      const session: FakeSession = {
        id: nextId("sesn"),
        agent: { type: "agent", id: agent.id, version: agent.version, system: agent.system },
        events: [],
        streams: new Set(),
        usage: {
          input_tokens: 82,
          output_tokens: 253,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 7713, ephemeral_1h_input_tokens: 0 },
        },
        budget: (body?.budget as Json | undefined) ?? null,
        status: "idle",
      };
      sessions.set(session.id, session);
      return json(200, sessionBody(session, body));
    }
    if ((match = /^\/v1\/sessions\/([^/]+)$/.exec(path))) {
      const session = sessions.get(match[1]!);
      if (!session) return apiError(404, "not_found_error", "session not found");
      if (method === "GET") return json(200, sessionBody(session, null));
      if (method === "POST") {
        if (body && "budget" in body) {
          if (!session.budget) {
            return apiError(400, "invalid_request_error", "budget_create_only");
          }
          session.budget = body.budget as Json | null;
        }
        return json(200, sessionBody(session, null));
      }
      if (method === "DELETE") {
        if (session.status === "running") {
          return apiError(409, "invalid_request_error", "session is running");
        }
        for (const controller of session.streams) controller.close();
        sessions.delete(session.id);
        return json(200, { id: session.id, type: "session_deleted" });
      }
    }
    if ((match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(path))) {
      const session = sessions.get(match[1]!);
      if (!session) return apiError(404, "not_found_error", "session not found");
      if (method === "GET") return page(session.events, url, pageSize);
      if (method === "POST") {
        const events = (body?.events ?? []) as Json[];
        const last = events.findIndex((event) => event.type === "system.message");
        if (last !== -1 && last !== events.length - 1) {
          return apiError(
            400,
            "invalid_request_error",
            "system.message must be the last event in the request"
          );
        }
        if (events.some((event) => event.type === "user.interrupt")) session.status = "idle";
        return json(200, { data: events.map((event) => logEvent(session, event)) });
      }
    }
    return apiError(404, "not_found_error", `no fake route for ${method} ${path}`);
  };

  const sessionBody = (session: FakeSession, created: Json | null) => ({
    type: "session",
    id: session.id,
    agent: session.agent,
    status: session.status,
    title: created?.title ?? null,
    metadata: created?.metadata ?? {},
    usage: session.usage,
    budget: session.budget,
  });

  const openStream = (url: URL, signal: AbortSignal | null | undefined): Response => {
    const id = /^\/v1\/sessions\/([^/]+)\/events\/stream$/.exec(url.pathname)?.[1];
    const session = id ? sessions.get(id) : undefined;
    if (!session) return apiError(404, "not_found_error", "session not found");
    let own: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        own = controller;
        session.streams.add(controller);
        signal?.addEventListener(
          "abort",
          () => {
            session.streams.delete(controller);
            controller.error(new DOMException("aborted", "AbortError"));
          },
          { once: true }
        );
      },
      cancel() {
        session.streams.delete(own);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : null;
    const body = raw ? (JSON.parse(raw) as Json) : null;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname.endsWith("/events/stream"))
      return Promise.resolve(openStream(url, init?.signal));
    return Promise.resolve(route(method, url, body));
  };

  return {
    fetch,
    calls,
    state,
    agents,
    agentVersions,
    environments,
    sessions,
    messageReplies,
    client: () =>
      new Anthropic({
        apiKey: "sk-ant-test-not-a-real-key",
        baseURL: "https://api.anthropic.test",
        maxRetries: 0,
        fetch,
      }),
    /** Logs an event as the session itself would (model output, idle) and streams it. */
    emit: (sessionId: string, event: Json): Json => logEvent(sessions.get(sessionId)!, event),
    /** Sends a raw SSE item to every open stream, like an `event_delta` that never reaches the log. */
    streamOnly: (sessionId: string, item: Json) => {
      for (const controller of sessions.get(sessionId)!.streams) {
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(item)}\n\n`));
      }
    },
    openStreams: (sessionId: string) => sessions.get(sessionId)?.streams.size ?? 0,
  };
};

export type FakeManagedAgentsApi = ReturnType<typeof createFakeManagedAgentsApi>;
