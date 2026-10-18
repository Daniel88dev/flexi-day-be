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

const shiftDays = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

type GraphInstance = {
  id?: unknown;
  isAllDay?: unknown;
  start?: { dateTime?: unknown; timeZone?: unknown };
};

const IMMUTABLE_IDS = 'IdType="ImmutableId"';

const seriesBodyOf = ({
  start: _start,
  end: _end,
  isAllDay: _isAllDay,
  recurrence: _recurrence,
  ...body
}: Omit<MicrosoftEventPayload, "transactionId">) => body;

/**
 * The date an instance falls on in `timeZone`. The instances read asks Graph
 * for times in that zone, so the date part is already local. An all-day
 * instance is midnight to midnight, and converting its midnight from UTC
 * would move it a day back west of UTC. Only a timed instance Graph still
 * answered in UTC gets converted.
 */
const instanceDate = (instance: GraphInstance, timeZone: string): string | null => {
  const dateTime = instance.start?.dateTime;
  if (typeof dateTime !== "string") return null;
  if (instance.isAllDay === true || instance.start?.timeZone !== "UTC") {
    return dateTime.slice(0, 10);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(`${dateTime.slice(0, 19)}Z`));
};

export const createMicrosoftDriver = (
  options: { baseUrl?: string; timeoutMs?: number } = {}
): CalendarDriver => {
  const baseUrl = options.baseUrl ?? GRAPH_URL;

  const request = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    token: string,
    body?: object,
    prefer: string = IMMUTABLE_IDS
  ): Promise<GraphAnswer> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        // ImmutableId keeps the id stable if the user moves the event to another calendar.
        prefer,
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
      const { transactionId: _immutable, ...fields } = payload;
      // The engine patches a series only when its shape is unchanged, and
      // writing the rule again could bring cancelled occurrences back.
      const changes = event.cancelledDates ? seriesBodyOf(fields) : fields;
      return withAccessToken(context, async (token) => {
        const answer = await request("PATCH", eventPath(providerEventId), token, changes);
        if (answer.status === 200) return eventId(answer);
        if (answer.status === 404) return { ok: false, error: "not_found" };
        return failure(answer);
      });
    },

    cancelOccurrence: (context, seriesId, date, timeZone) =>
      withAccessToken(context, async (token): Promise<DriverResult | Unauthorized> => {
        // A day either side covers every zone; the match below is by local date.
        const query = new URLSearchParams({
          startDateTime: `${shiftDays(date, -1)}T00:00:00Z`,
          endDateTime: `${shiftDays(date, 2)}T00:00:00Z`,
          $select: "id,start,isAllDay",
        });
        const read = await request(
          "GET",
          `${eventPath(seriesId)}/instances?${query.toString()}`,
          token,
          undefined,
          `${IMMUTABLE_IDS}, outlook.timezone="${timeZone}"`
        );
        if (read.status === 404) return { ok: true };
        if (read.status !== 200) return failure(read);
        const instances = (read.body as { value?: GraphInstance[] } | undefined)?.value ?? [];
        const match = instances.find((instance) => instanceDate(instance, timeZone) === date);
        if (typeof match?.id !== "string") return { ok: true };
        const removed = await request("DELETE", eventPath(match.id), token);
        if (removed.status === 204 || removed.status === 200 || removed.status === 404) {
          return { ok: true };
        }
        return failure(removed);
      }),

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
