import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { setupTestEnvironment, cleanupTestData, type TestContext } from "./helpers/testSetup.js";
import { db } from "../../db/db.js";
import {
  calendarCapability,
  calendarConnection,
  calendarProvider,
  calendarSyncFakeEvents,
} from "../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { FAKE_PLAIN_MARKER } from "../../services/calendarConnection/providers/fake.js";
import type { CalendarConnectionRecord } from "../../services/calendarConnection/types.js";
import { buildDesired } from "../../services/calendarSync/eventBuilder.js";
import { recordTypeLabels } from "../../services/recordType/recordTypeLabels.js";
import { calendarDriver } from "../../services/calendarSync/drivers/index.js";
import type { DriverContext } from "../../services/calendarSync/drivers/types.js";

const event = (capability: calendarCapability) =>
  buildDesired({
    record: {
      id: uuidv4(),
      vacationType: CalendarRecordType.Vacation,
      requestedDay: "2026-10-12",
      startTime: null,
      endTime: null,
      note: null,
    },
    provider: calendarProvider.Google,
    capability,
    timeZone: "Europe/Prague",
    labels: recordTypeLabels("en"),
    configId: uuidv4(),
    ledgerId: uuidv4(),
  })!;

const calls = (connectionId: string) =>
  db
    .select()
    .from(calendarSyncFakeEvents)
    .where(eq(calendarSyncFakeEvents.connectionId, connectionId))
    .orderBy(asc(calendarSyncFakeEvents.createdAt));

describe("Calendar fake driver E2E", () => {
  let context: TestContext;
  let connection: CalendarConnectionRecord;

  const driverContext = (token = "fake-access-google-fake-code"): DriverContext => ({
    connection,
    accessToken: () => Promise.resolve(token),
  });

  beforeAll(async () => {
    context = await setupTestEnvironment();
    [connection] = (await db
      .insert(calendarConnection)
      .values({
        id: uuidv4(),
        userId: context.user1.id,
        provider: calendarProvider.Google,
        refreshTokenEnc: "encrypted-refresh-token",
        grantedScopes: "https://www.googleapis.com/auth/calendar.events.owned",
      })
      .returning()) as [CalendarConnectionRecord];
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("is the driver CALENDAR_SYNC_DRIVER=fake selects, and it records each call in its table", async () => {
    const driver = calendarDriver(calendarProvider.Google)!;
    const written = event(calendarCapability.Status);

    const inserted = await driver.insert(driverContext(), written);
    if (!inserted.ok) throw new Error(`insert failed: ${inserted.error}`);
    const patched = await driver.patch(driverContext(), inserted.providerEventId, written);
    const deleted = await driver.delete(driverContext(), inserted.providerEventId);
    const afterDelete = await driver.patch(driverContext(), inserted.providerEventId, written);

    expect(patched).toEqual({ ok: true, providerEventId: inserted.providerEventId });
    expect(deleted).toEqual({ ok: true });
    expect(afterDelete).toEqual({ ok: false, error: "not_found" });
    const rows = await calls(connection.id);
    expect(rows.map((row) => [row.operation, row.result])).toEqual([
      ["INSERT", "ok"],
      ["PATCH", "ok"],
      ["DELETE", "ok"],
      ["PATCH", "not_found"],
    ]);
    expect(rows[0]).toMatchObject({
      provider: calendarProvider.Google,
      providerEventId: inserted.providerEventId,
      payload: written.payload,
    });
  });

  it("refuses status types for a plain-marked connection and takes the plain retry", async () => {
    const driver = calendarDriver(calendarProvider.Google)!;
    const plainAccount = driverContext(`fake-access-google-fake-code-${FAKE_PLAIN_MARKER}`);
    await db
      .delete(calendarSyncFakeEvents)
      .where(eq(calendarSyncFakeEvents.connectionId, connection.id));

    const refused = await driver.insert(plainAccount, event(calendarCapability.Unknown));
    const retried = await driver.insert(plainAccount, event(calendarCapability.Plain));

    expect(refused).toEqual({
      ok: false,
      error: "capability_refused",
      reason: "malformedWorkingLocationEvent",
    });
    expect(retried).toMatchObject({ ok: true });
    const rows = await calls(connection.id);
    expect(rows.map((row) => row.result)).toEqual(["capability_refused", "ok"]);
    expect(rows[1]?.payload).toMatchObject({ eventType: "default" });
  });
});
