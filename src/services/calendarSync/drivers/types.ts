import type { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import type { CalendarConnectionRecord } from "../../calendarConnection/types.js";
import type { DesiredEvent } from "../eventBuilder.js";

/**
 * Hands out the connection's access token. `forceRefresh` skips the cached
 * token after the provider answered 401 to it. Throws
 * `ProviderGrantRevokedError` once the grant is gone.
 */
export type AccessTokenSource = (options?: { forceRefresh?: boolean }) => Promise<string>;

export type DriverContext = {
  connection: CalendarConnectionRecord;
  accessToken: AccessTokenSource;
};

export type DriverFailure =
  /** Google refused a status event type; `reason` is its `malformed…` reason. */
  | { ok: false; error: "capability_refused"; reason: string }
  | { ok: false; error: "auth_revoked"; reason: string }
  /** `retryAfterSeconds` is null when the provider named no delay. */
  | { ok: false; error: "throttled"; retryAfterSeconds: number | null }
  /** Patch only: the event is gone at the provider, so it has to be inserted again. */
  | { ok: false; error: "not_found" }
  /** `reason` is a provider error code or an HTTP status, never a provider message. */
  | { ok: false; error: "other"; reason: string };

export type DriverResult<T extends object = object> = ({ ok: true } & T) | DriverFailure;

export type WriteResult = DriverResult<{ providerEventId: string }>;

/** Writes to the connection's primary calendar, one request per event. */
export interface CalendarDriver {
  provider: calendarProvider;
  insert: (context: DriverContext, event: DesiredEvent) => Promise<WriteResult>;
  patch: (
    context: DriverContext,
    providerEventId: string,
    event: DesiredEvent
  ) => Promise<WriteResult>;
  /** An event already gone at the provider counts as deleted. */
  delete: (context: DriverContext, providerEventId: string) => Promise<DriverResult>;
  /**
   * Graph only: removes the occurrence of a series that falls on `date` in
   * `timeZone`. A day with no occurrence counts as done.
   */
  cancelOccurrence?: (
    context: DriverContext,
    seriesId: string,
    date: string,
    timeZone: string
  ) => Promise<DriverResult>;
}
