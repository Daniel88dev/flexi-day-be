import { and, eq } from "drizzle-orm";
import { db } from "../../../db/db.js";
import {
  calendarProvider,
  calendarSyncFakeEvents,
} from "../../../db/schema/calendar-connection-schema.js";
import { generateRandomUUID } from "../../../utils/generateUUID.js";
import { FAKE_PLAIN_MARKER } from "../../calendarConnection/providers/fake.js";
import type { DesiredEvent } from "../eventBuilder.js";
import { withAccessToken } from "./shared.js";
import type { CalendarDriver, DriverContext, DriverFailure, WriteResult } from "./types.js";

export type FakeCall = Omit<typeof calendarSyncFakeEvents.$inferInsert, "id" | "createdAt">;

export interface FakeEventStore {
  record: (call: FakeCall) => Promise<void>;
  /** True when the event was inserted and not deleted since. */
  isLive: (connectionId: string, providerEventId: string) => Promise<boolean>;
}

const live = (calls: Pick<FakeCall, "operation" | "result">[]): boolean =>
  calls.some((call) => call.operation === "INSERT" && call.result === "ok") &&
  !calls.some((call) => call.operation === "DELETE" && call.result === "ok");

export const memoryFakeStore = (): FakeEventStore & { calls: FakeCall[] } => {
  const calls: FakeCall[] = [];
  return {
    calls,
    record: (call) => {
      calls.push(call);
      return Promise.resolve();
    },
    isLive: (connectionId, providerEventId) =>
      Promise.resolve(
        live(
          calls.filter(
            (call) => call.connectionId === connectionId && call.providerEventId === providerEventId
          )
        )
      ),
  };
};

/** Keeps the calls in `calendar_sync_fake_events`, which the dev surface reads back. */
export const databaseFakeStore = (): FakeEventStore => ({
  record: async (call) => {
    await db.insert(calendarSyncFakeEvents).values({ id: generateRandomUUID(), ...call });
  },
  isLive: async (connectionId, providerEventId) =>
    live(
      await db
        .select({
          operation: calendarSyncFakeEvents.operation,
          result: calendarSyncFakeEvents.result,
        })
        .from(calendarSyncFakeEvents)
        .where(
          and(
            eq(calendarSyncFakeEvents.connectionId, connectionId),
            eq(calendarSyncFakeEvents.providerEventId, providerEventId)
          )
        )
    ),
});

const statusRefusal = (event: DesiredEvent): DriverFailure | undefined => {
  if (event.provider !== calendarProvider.Google) return undefined;
  if (event.payload.eventType === "workingLocation") {
    return { ok: false, error: "capability_refused", reason: "malformedWorkingLocationEvent" };
  }
  if (event.payload.eventType === "outOfOffice") {
    return { ok: false, error: "capability_refused", reason: "malformedOutOfOfficeEvent" };
  }
  return undefined;
};

/**
 * `CALENDAR_SYNC_DRIVER=fake`: records every call and never calls out. It
 * refuses Google's status types the way a personal Gmail account does when
 * told to, or by default when the access token carries `FAKE_PLAIN_MARKER`.
 */
export const createFakeDriver = (
  provider: calendarProvider,
  options: { store: FakeEventStore; refuseStatusTypes?: boolean }
): CalendarDriver => {
  const { store } = options;
  const refuses = (token: string) => options.refuseStatusTypes ?? token.includes(FAKE_PLAIN_MARKER);

  const write = (
    context: DriverContext,
    operation: FakeCall["operation"],
    event: DesiredEvent,
    existingId?: string
  ): Promise<WriteResult> =>
    withAccessToken(context, async (token): Promise<WriteResult> => {
      const base = { connectionId: context.connection.id, provider, operation };
      const refusal = refuses(token) ? statusRefusal(event) : undefined;
      if (refusal) {
        await store.record({
          ...base,
          providerEventId: existingId ?? null,
          payload: event.payload,
          result: refusal.error,
        });
        return refusal;
      }
      if (existingId && !(await store.isLive(context.connection.id, existingId))) {
        await store.record({
          ...base,
          providerEventId: existingId,
          payload: event.payload,
          result: "not_found",
        });
        return { ok: false, error: "not_found" };
      }
      const providerEventId =
        existingId ?? `fake-${provider.toLowerCase()}-${generateRandomUUID()}`;
      await store.record({ ...base, providerEventId, payload: event.payload, result: "ok" });
      return { ok: true, providerEventId };
    });

  return {
    provider,
    insert: (context, event) => write(context, "INSERT", event),
    patch: (context, providerEventId, event) => write(context, "PATCH", event, providerEventId),
    cancelOccurrence: (context, seriesId, date) =>
      withAccessToken(context, async () => {
        await store.record({
          connectionId: context.connection.id,
          provider,
          operation: "CANCEL",
          providerEventId: seriesId,
          payload: { date },
          result: "ok",
        });
        return { ok: true };
      }),
    delete: (context, providerEventId) =>
      withAccessToken(context, async () => {
        await store.record({
          connectionId: context.connection.id,
          provider,
          operation: "DELETE",
          providerEventId,
          payload: null,
          result: "ok",
        });
        return { ok: true };
      }),
  };
};
