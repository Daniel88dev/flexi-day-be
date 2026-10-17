import { describe, it, expect } from "vitest";
import {
  calendarCapability,
  calendarProvider,
} from "../../../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../../../db/schema/vacation-schema.js";
import {
  createFakeAdapter,
  FAKE_PLAIN_MARKER,
} from "../../../calendarConnection/providers/fake.js";
import { ProviderGrantRevokedError } from "../../../calendarConnection/providers/types.js";
import { buildDesired, type BuildInput } from "../../eventBuilder.js";
import { recordTypeLabels } from "../../../recordType/recordTypeLabels.js";
import { createFakeDriver, memoryFakeStore } from "../fakeDriver.js";
import type { AccessTokenSource, CalendarDriver, DriverContext } from "../types.js";
import { connection } from "./context.js";

const g = calendarProvider.Google;

const contextWith = (provider: calendarProvider, token = "fake-access-token"): DriverContext => ({
  connection: connection(provider),
  accessToken: () => Promise.resolve(token),
});

const build = (
  capability: calendarCapability,
  overrides: Partial<BuildInput["record"]> = {},
  provider: calendarProvider = g
) =>
  buildDesired({
    record: {
      id: "vac-1",
      vacationType: CalendarRecordType.Vacation,
      requestedDay: "2026-10-12",
      startTime: null,
      endTime: null,
      note: null,
      ...overrides,
    },
    provider,
    capability,
    timeZone: "Europe/Prague",
    labels: recordTypeLabels("en"),
    configId: "cfg-1",
    ledgerId: "ledger-1",
  });

/** What the engine does: try the connection's capability, fall back to plain once. */
const writeWithFallback = async (driver: CalendarDriver, context: DriverContext, record = {}) => {
  const first = build(calendarCapability.Unknown, record);
  if (!first) return { first: null, retry: null };
  const attempt = await driver.insert(context, first);
  if (attempt.ok || attempt.error !== "capability_refused") return { first: attempt, retry: null };
  const plain = build(calendarCapability.Plain, record);
  return { first: attempt, retry: plain ? await driver.insert(context, plain) : null };
};

describe("fake driver", () => {
  it("records an insert, a patch and a delete and never calls out", async () => {
    const store = memoryFakeStore();
    const driver = createFakeDriver(g, { store });
    const context = contextWith(g);
    const event = build(calendarCapability.Status)!;

    const inserted = await driver.insert(context, event);
    if (!inserted.ok) throw new Error("insert failed");
    const patched = await driver.patch(context, inserted.providerEventId, event);
    const deleted = await driver.delete(context, inserted.providerEventId);

    expect(patched).toEqual({ ok: true, providerEventId: inserted.providerEventId });
    expect(deleted).toEqual({ ok: true });
    expect(store.calls.map((call) => [call.operation, call.result])).toEqual([
      ["INSERT", "ok"],
      ["PATCH", "ok"],
      ["DELETE", "ok"],
    ]);
    expect(store.calls[0]).toMatchObject({
      connectionId: "connection-1",
      provider: g,
      providerEventId: inserted.providerEventId,
      payload: event.payload,
    });
  });

  it("reports a patch of an event it never wrote, or already deleted, as not found", async () => {
    const store = memoryFakeStore();
    const driver = createFakeDriver(g, { store });
    const context = contextWith(g);
    const event = build(calendarCapability.Status)!;

    expect(await driver.patch(context, "never-written", event)).toEqual({
      ok: false,
      error: "not_found",
    });
    const inserted = await driver.insert(context, event);
    if (!inserted.ok) throw new Error("insert failed");
    await driver.delete(context, inserted.providerEventId);
    expect(await driver.patch(context, inserted.providerEventId, event)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("maps a revoked grant to auth_revoked", async () => {
    const store = memoryFakeStore();
    const revoked: AccessTokenSource = () =>
      Promise.reject(new ProviderGrantRevokedError("invalid_grant"));

    const result = await createFakeDriver(g, { store }).insert(
      { connection: connection(g), accessToken: revoked },
      build(calendarCapability.Status)!
    );

    expect(result).toEqual({ ok: false, error: "auth_revoked", reason: "invalid_grant" });
    expect(store.calls).toHaveLength(0);
  });
});

describe("fake driver refusing status types", () => {
  const refusing = () => {
    const store = memoryFakeStore();
    return { store, driver: createFakeDriver(g, { store, refuseStatusTypes: true }) };
  };

  it("refuses a full day as Google refuses working location, and the plain retry lands", async () => {
    const { store, driver } = refusing();

    const { first, retry } = await writeWithFallback(driver, contextWith(g));

    expect(first).toEqual({
      ok: false,
      error: "capability_refused",
      reason: "malformedWorkingLocationEvent",
    });
    expect(retry).toMatchObject({ ok: true });
    expect(store.calls.map((call) => call.result)).toEqual(["capability_refused", "ok"]);
    expect(store.calls[1]?.payload).toMatchObject({
      eventType: "default",
      start: { date: "2026-10-12" },
      transparency: "opaque",
    });
  });

  it("refuses a timed row as Google refuses Out of office, and the plain retry is timed", async () => {
    const { store, driver } = refusing();

    const { first, retry } = await writeWithFallback(driver, contextWith(g), {
      startTime: "09:00:00",
      endTime: "12:00:00",
    });

    expect(first).toMatchObject({
      error: "capability_refused",
      reason: "malformedOutOfOfficeEvent",
    });
    expect(retry).toMatchObject({ ok: true });
    expect(store.calls[1]?.payload).toMatchObject({
      eventType: "default",
      start: { dateTime: "2026-10-12T09:00:00", timeZone: "Europe/Prague" },
    });
  });

  it("writes nothing for Home office once it falls back to plain", async () => {
    const { store, driver } = refusing();

    const { first, retry } = await writeWithFallback(driver, contextWith(g), {
      vacationType: CalendarRecordType.HomeOffice,
    });

    expect(first).toMatchObject({ error: "capability_refused" });
    expect(retry).toBeNull();
    expect(store.calls.map((call) => call.result)).toEqual(["capability_refused"]);
  });

  it("refuses a patch to a status type too", async () => {
    const store = memoryFakeStore();
    const accepting = createFakeDriver(g, { store });
    const inserted = await accepting.insert(contextWith(g), build(calendarCapability.Plain)!);
    if (!inserted.ok) throw new Error("insert failed");

    const result = await createFakeDriver(g, { store, refuseStatusTypes: true }).patch(
      contextWith(g),
      inserted.providerEventId,
      build(calendarCapability.Status)!
    );

    expect(result).toMatchObject({ error: "capability_refused" });
  });

  it("never refuses a Microsoft event, which has no status types", async () => {
    const store = memoryFakeStore();
    const driver = createFakeDriver(calendarProvider.Microsoft, { store, refuseStatusTypes: true });

    const result = await driver.insert(
      contextWith(calendarProvider.Microsoft),
      build(calendarCapability.Unknown, {}, calendarProvider.Microsoft)!
    );

    expect(result).toMatchObject({ ok: true });
  });
});

describe("fake driver flipped by the connection's token", () => {
  const fakeAdapterToken = async (code: string, refresh: boolean) => {
    const adapter = createFakeAdapter(g, "http://localhost:8080/callback");
    const tokens = await adapter.exchangeCode(code);
    if (!refresh) return tokens.accessToken;
    const fresh = await adapter.accessToken({
      accessToken: tokens.accessToken,
      expiresAt: new Date(0),
      refreshToken: tokens.refreshToken,
    });
    return fresh.accessToken;
  };

  it.each([false, true])(
    "refuses status types for a connection made with the plain marker (refreshed: %s)",
    async (refreshed) => {
      const store = memoryFakeStore();
      const token = await fakeAdapterToken(`fake-code-${FAKE_PLAIN_MARKER}`, refreshed);

      const result = await createFakeDriver(g, { store }).insert(
        contextWith(g, token),
        build(calendarCapability.Unknown)!
      );

      expect(result).toMatchObject({ error: "capability_refused" });
    }
  );

  it("accepts status types for an ordinary fake connection", async () => {
    const store = memoryFakeStore();
    const token = await fakeAdapterToken("fake-code", true);

    expect(
      await createFakeDriver(g, { store }).insert(
        contextWith(g, token),
        build(calendarCapability.Unknown)!
      )
    ).toMatchObject({ ok: true });
  });
});
