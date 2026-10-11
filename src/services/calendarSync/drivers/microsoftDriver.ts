import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import type { DesiredEvent, MicrosoftEventPayload } from "../eventBuilder.js";
import {
  otherFailure,
  REQUEST_TIMEOUT_MS,
  retryAfterSeconds,
  safeReason,
  withAccessToken,
  type Unauthorized,
} from "./shared.js";
import type { CalendarDriver, DriverFailure, DriverResult, WriteResult } from "./types.js";

export const GRAPH_URL = "https://graph.microsoft.com/v1.0";

type GraphAnswer = { status: number; headers: Headers; body: unknown };

const graphCode = (body: unknown): unknown =>
  (body as { error?: { code?: unknown } } | undefined)?.error?.code;

const payloadOf = (event: DesiredEvent): MicrosoftEventPayload | DriverFailure =>
  event.provider === calendarProvider.Microsoft ? event.payload : otherFailure("provider_mismatch");

const failure = (answer: GraphAnswer): DriverFailure | Unauthorized => {
  const code = safeReason(graphCode(answer.body), `http_${answer.status}`);
  if (answer.status === 401) return { unauthorized: true, reason: code };
  if (answer.status === 429 || answer.status === 503) {
    return {
      ok: false,
      error: "throttled",
      retryAfterSeconds: retryAfterSeconds(answer.headers.get("retry-after")),
    };
  }
  return otherFailure(code);
};

const eventId = (answer: GraphAnswer): WriteResult => {
  const id = (answer.body as { id?: unknown } | undefined)?.id;
  return typeof id === "string"
    ? { ok: true, providerEventId: id }
    : otherFailure("missing_event_id");
};

export const createMicrosoftDriver = (
  options: { baseUrl?: string; timeoutMs?: number } = {}
): CalendarDriver => {
  const baseUrl = options.baseUrl ?? GRAPH_URL;

  const request = async (
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    token: string,
    body?: object
  ): Promise<GraphAnswer> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        // Keeps the id stable if the user moves the event to another calendar.
        prefer: 'IdType="ImmutableId"',
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, headers: response.headers, body: parsed };
  };

  const eventPath = (providerEventId: string) =>
    `/me/events/${encodeURIComponent(providerEventId)}`;

  return {
    provider: calendarProvider.Microsoft,

    insert: (context, event) => {
      const payload = payloadOf(event);
      if ("ok" in payload) return Promise.resolve(payload);
      return withAccessToken(context, async (token) => {
        const answer = await request("POST", "/me/events", token, payload);
        return answer.status === 201 || answer.status === 200 ? eventId(answer) : failure(answer);
      });
    },

    patch: (context, providerEventId, event) => {
      const payload = payloadOf(event);
      if ("ok" in payload) return Promise.resolve(payload);
      const { transactionId: _immutable, ...changes } = payload;
      return withAccessToken(context, async (token) => {
        const answer = await request("PATCH", eventPath(providerEventId), token, changes);
        if (answer.status === 200) return eventId(answer);
        if (answer.status === 404) return { ok: false, error: "not_found" };
        return failure(answer);
      });
    },

    delete: (context, providerEventId) =>
      withAccessToken(context, async (token): Promise<DriverResult | Unauthorized> => {
        const answer = await request("DELETE", eventPath(providerEventId), token);
        if (answer.status === 204 || answer.status === 200 || answer.status === 404) {
          return { ok: true };
        }
        return failure(answer);
      }),
  };
};
