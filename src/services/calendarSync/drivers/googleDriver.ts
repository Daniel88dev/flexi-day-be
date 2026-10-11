import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { OAuth2Client } from "google-auth-library";
import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import type { DesiredEvent, GoogleEventPayload } from "../eventBuilder.js";
import {
  otherFailure,
  REQUEST_TIMEOUT_MS,
  retryAfterSeconds,
  safeReason,
  withAccessToken,
  type Unauthorized,
} from "./shared.js";
import type { CalendarDriver, DriverFailure, DriverResult, WriteResult } from "./types.js";

const CALENDAR_ID = "primary";

const CAPABILITY_REASONS = new Set(["malformedWorkingLocationEvent", "malformedOutOfOfficeEvent"]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

type GoogleFailure = { status: number | undefined; reason: unknown; retryAfter: string | null };

const describeError = (error: unknown): GoogleFailure => {
  const response = (
    error as {
      response?: {
        status?: number;
        headers?: { get?: (name: string) => string | null } & Record<string, unknown>;
        data?: { error?: { errors?: { reason?: unknown }[] } };
      };
    }
  ).response;
  const headers = response?.headers;
  const raw =
    typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  const retryAfter = typeof raw === "string" ? raw : null;
  return {
    status: response?.status,
    reason: response?.data?.error?.errors?.[0]?.reason,
    retryAfter,
  };
};

const failure = (error: unknown): DriverFailure | Unauthorized => {
  const { status, reason, retryAfter } = describeError(error);
  if (status === undefined) {
    const code = (error as { code?: unknown }).code;
    return otherFailure(safeReason(code, safeReason((error as Error).name, "network")));
  }
  const code = safeReason(reason, `http_${status}`);
  if (status === 401) return { unauthorized: true, reason: code };
  if (status === 400 && typeof reason === "string" && CAPABILITY_REASONS.has(reason)) {
    return { ok: false, error: "capability_refused", reason };
  }
  if (
    status === 429 ||
    (status === 403 && typeof reason === "string" && RATE_LIMIT_REASONS.has(reason))
  ) {
    return { ok: false, error: "throttled", retryAfterSeconds: retryAfterSeconds(retryAfter) };
  }
  return otherFailure(code);
};

const gone = (error: unknown): boolean => {
  const { status } = describeError(error);
  return status === 404 || status === 410;
};

const payloadOf = (event: DesiredEvent): GoogleEventPayload | DriverFailure =>
  event.provider === calendarProvider.Google ? event.payload : otherFailure("provider_mismatch");

const eventId = (data: calendar_v3.Schema$Event): WriteResult =>
  data.id ? { ok: true, providerEventId: data.id } : otherFailure("missing_event_id");

export const createGoogleDriver = (
  options: { rootUrl?: string; timeoutMs?: number } = {}
): CalendarDriver => {
  const api = calendar({ version: "v3", rootUrl: options.rootUrl });
  // The engine owns retries and backoff; the client's own would hide a 429 from it.
  const requestOptions = { retry: false, timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS };

  const auth = (token: string) => {
    const client = new OAuth2Client();
    client.setCredentials({ access_token: token });
    return client;
  };

  return {
    provider: calendarProvider.Google,

    insert: (context, event) => {
      const payload = payloadOf(event);
      if ("ok" in payload) return Promise.resolve(payload);
      return withAccessToken(context, async (token) => {
        try {
          const { data } = await api.events.insert(
            { auth: auth(token), calendarId: CALENDAR_ID, requestBody: payload },
            requestOptions
          );
          return eventId(data);
        } catch (error) {
          return failure(error);
        }
      });
    },

    patch: (context, providerEventId, event) => {
      const payload = payloadOf(event);
      if ("ok" in payload) return Promise.resolve(payload);
      return withAccessToken(context, async (token) => {
        try {
          const { data } = await api.events.patch(
            {
              auth: auth(token),
              calendarId: CALENDAR_ID,
              eventId: providerEventId,
              requestBody: payload,
            },
            requestOptions
          );
          return eventId(data);
        } catch (error) {
          return gone(error) ? { ok: false, error: "not_found" } : failure(error);
        }
      });
    },

    delete: (context, providerEventId) =>
      withAccessToken(context, async (token): Promise<DriverResult | Unauthorized> => {
        try {
          await api.events.delete(
            { auth: auth(token), calendarId: CALENDAR_ID, eventId: providerEventId },
            requestOptions
          );
          return { ok: true };
        } catch (error) {
          return gone(error) ? { ok: true } : failure(error);
        }
      }),
  };
};
