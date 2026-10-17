import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/db.js";
import { cleanupTestData, createTestGroup, createTestUser } from "./helpers/testSetup.js";
import {
  calendarSync,
  calendarSyncScope,
  calendarSyncTypes,
} from "../../db/schema/calendar-sync-schema.js";
import {
  calendarCapability,
  calendarConnection,
  calendarConnectionStatus,
  calendarProvider,
  calendarSyncEventKind,
  calendarSyncEvents,
  calendarSyncFakeEvents,
} from "../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType, vacation } from "../../db/schema/vacation-schema.js";
import { encryptOAuthToken } from "../../utils/oauthTokens.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import {
  FAKE_PLAIN_MARKER,
  FAKE_REVOKED_MARKER,
} from "../../services/calendarConnection/providers/fake.js";
import type { CalendarDriver } from "../../services/calendarSync/drivers/types.js";
import { purgeTarget, syncTarget } from "../../services/calendarSync/syncEngine.js";

const { entitled, driverOverride } = vi.hoisted(() => ({
  entitled: { value: true },
  driverOverride: {
    value: undefined as ((driver: CalendarDriver) => CalendarDriver | undefined) | undefined,
  },
}));

vi.mock("../../services/calendarConnection/entitlement.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/calendarConnection/entitlement.js")>()),
  isCalendarSyncEntitled: () => Promise.resolve(entitled.value),
}));

vi.mock("../../services/calendarSync/drivers/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/calendarSync/drivers/index.js")>();
  return {
    calendarDriver: (provider: calendarProvider) => {
      const driver = actual.calendarDriver(provider);
      return driver && driverOverride.value ? driverOverride.value(driver) : driver;
    },
  };
});

const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const day = (n: number) => `${NEXT_YEAR}-03-${String(n).padStart(2, "0")}`;
const HOUR_MS = 60 * 60 * 1000;

describe("calendar sync engine on the fake driver", () => {
  let ownerId: string;
  let groupId: string;
  let configId: string;
  let connectionId: string;

  const target = async () =>
    (await db.select().from(calendarSync).where(eq(calendarSync.id, configId)))[0]!;

  const connection = async () =>
    (await db.select().from(calendarConnection).where(eq(calendarConnection.id, connectionId)))[0];

  const ledger = () =>
    db.select().from(calendarSyncEvents).where(eq(calendarSyncEvents.calendarSyncId, configId));

  const calls = () =>
    db
      .select()
      .from(calendarSyncFakeEvents)
      .where(eq(calendarSyncFakeEvents.connectionId, connectionId))
      .orderBy(asc(calendarSyncFakeEvents.createdAt));

  const operations = async () => (await calls()).map((call) => call.operation);

  const addVacation = async (
    requestedDay: string,
    fields: Partial<typeof vacation.$inferInsert> = {}
  ) => {
    const id = uuidv4();
    await db.insert(vacation).values({
      id,
      userId: ownerId,
      groupId,
      requestId: uuidv4(),
      requestedDay,
      approvedAt: new Date(),
      ...fields,
    });
    return id;
  };

  /** A connection as the fake consent round leaves it; `code` carries the fake adapter's markers. */
  const connect = async (provider: calendarProvider, code = "fake-code", tokenValid = true) => {
    const slug = provider.toLowerCase();
    connectionId = uuidv4();
    await db.insert(calendarConnection).values({
      id: connectionId,
      userId: ownerId,
      provider,
      refreshTokenEnc: await encryptOAuthToken(`fake-refresh-${slug}-${code}`),
      accessTokenEnc: await encryptOAuthToken(`fake-access-${slug}-${code}`),
      accessTokenExpiresAt: new Date(Date.now() + (tokenValid ? HOUR_MS : -HOUR_MS)),
      grantedScopes: "calendar",
    });
    configId = uuidv4();
    await db.insert(calendarSync).values({
      id: configId,
      userId: ownerId,
      name: "Mine",
      scope: calendarSyncScope.Me,
      token: `flx_live_${uuidv4().replaceAll("-", "")}`,
      connectionId,
      timeZone: "Europe/Prague",
      syncDueAt: new Date(),
    });
    await db.insert(calendarSyncTypes).values(
      [CalendarRecordType.Vacation, CalendarRecordType.HomeOffice, CalendarRecordType.Sick].map(
        (vacationType) => ({
          id: uuidv4(),
          calendarSyncId: configId,
          vacationType,
          color: "violet",
        })
      )
    );
  };

  const failing = (operation: "insert" | "patch" | "delete", failure: unknown) => {
    driverOverride.value = (driver) => ({
      ...driver,
      [operation]: () => Promise.resolve(failure),
    });
  };

  beforeAll(async () => {
    await cleanupTestData();
    ownerId = (await createTestUser("sync-engine-owner@test.com", "Sync Engine Owner", "pw")).id;
    groupId = (await createTestGroup("Sync engine team", ownerId)).id;
  });

  beforeEach(async () => {
    entitled.value = true;
    driverOverride.value = undefined;
    await db.delete(vacation);
    await db.delete(userSettings).where(eq(userSettings.userId, ownerId));
    await db.delete(calendarSync);
    await db.delete(calendarConnection);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("inserts the owner's approved records and learns the status capability", async () => {
    await connect(calendarProvider.Google);
    const fullDay = await addVacation(day(2));
    const homeOffice = await addVacation(day(3), { vacationType: CalendarRecordType.HomeOffice });
    await addVacation(day(4), { approvedAt: null });
    await addVacation(day(5), { rejectedAt: new Date() });
    await addVacation(day(6), { vacationType: CalendarRecordType.BankHoliday });

    const outcome = await syncTarget(configId);

    expect(outcome).toEqual({ status: "done" });
    expect((await calls()).map((call) => [call.operation, call.result])).toEqual([
      ["INSERT", "ok"],
      ["INSERT", "ok"],
    ]);
    const rows = await ledger();
    expect(rows.map((row) => row.vacationId).sort()).toEqual([fullDay, homeOffice].sort());
    expect(rows.every((row) => row.providerEventId?.startsWith("fake-google-"))).toBe(true);
    expect(rows.find((row) => row.vacationId === homeOffice)).toMatchObject({
      kind: calendarSyncEventKind.HomeOffice,
      eventType: "workingLocation",
    });
    expect(await target()).toMatchObject({ syncDueAt: null, syncAttempts: 0, lastError: null });
    expect((await target()).lastSyncedAt).toBeInstanceOf(Date);
    expect(await connection()).toMatchObject({
      capability: calendarCapability.Status,
      syncLeaseUntil: null,
    });
  });

  it("calls the provider not once when a finished sync runs again", async () => {
    await connect(calendarProvider.Microsoft);
    await addVacation(day(2));
    await addVacation(day(3), { startTime: "09:00", endTime: "12:00" });
    await syncTarget(configId);
    const before = await ledger();

    const outcome = await syncTarget(configId);

    expect(outcome).toEqual({ status: "done" });
    expect(await calls()).toHaveLength(2);
    expect(await ledger()).toEqual(before);
  });

  it("titles events in the owner's app language, English until one is set", async () => {
    await connect(calendarProvider.Microsoft);
    await addVacation(day(2));
    await syncTarget(configId);
    await db.insert(userSettings).values({ userId: ownerId, language: appLanguage.Czech });
    await addVacation(day(3));

    await syncTarget(configId);

    const sent = (await calls()).map((call) => [
      call.operation,
      (call.payload as { subject: string }).subject,
    ]);
    expect(sent).toEqual([
      ["INSERT", "Vacation"],
      ["PATCH", "Dovolená"],
      ["INSERT", "Dovolená"],
    ]);
  });

  it("patches a changed record on Microsoft and keeps its event", async () => {
    await connect(calendarProvider.Microsoft);
    const id = await addVacation(day(2));
    await syncTarget(configId);
    const [inserted] = await ledger();

    await db.update(vacation).set({ note: "Dentist" }).where(eq(vacation.id, id));
    await syncTarget(configId);

    expect(await operations()).toEqual(["INSERT", "PATCH"]);
    expect((await calls())[1]?.providerEventId).toBe(inserted?.providerEventId);
    const [patched] = await ledger();
    expect(patched?.id).toBe(inserted?.id);
    expect(patched?.contentHash).not.toBe(inserted?.contentHash);
  });

  it("patches a Google event whose type stays, so a note edit keeps its event id", async () => {
    await connect(calendarProvider.Google);
    const id = await addVacation(day(2), { startTime: "09:00", endTime: "12:00" });
    await syncTarget(configId);
    const [inserted] = await ledger();

    await db.update(vacation).set({ note: "Dentist" }).where(eq(vacation.id, id));
    await syncTarget(configId);

    expect(await operations()).toEqual(["INSERT", "PATCH"]);
    const [patched] = await ledger();
    expect(patched).toMatchObject({
      id: inserted?.id,
      providerEventId: inserted?.providerEventId,
      eventType: "outOfOffice",
    });
  });

  it("replaces a Google event whose type changes, which Google never allows", async () => {
    await connect(calendarProvider.Google);
    const id = await addVacation(day(2));
    await syncTarget(configId);
    const [inserted] = await ledger();

    await db
      .update(vacation)
      .set({ startTime: "13:00", endTime: "17:00" })
      .where(eq(vacation.id, id));
    await syncTarget(configId);

    const recorded = await calls();
    expect(recorded.map((call) => call.operation)).toEqual(["INSERT", "DELETE", "INSERT"]);
    expect(recorded[1]?.providerEventId).toBe(inserted?.providerEventId);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerEventId: recorded[2]?.providerEventId,
      eventType: "outOfOffice",
    });
  });

  it("deletes events whose record was cancelled, retyped out of the config or hard-deleted", async () => {
    await connect(calendarProvider.Google);
    const cancelled = await addVacation(day(2));
    const retyped = await addVacation(day(3));
    const hardDeleted = await addVacation(day(4));
    const kept = await addVacation(day(5));
    await syncTarget(configId);
    const written = new Map((await ledger()).map((row) => [row.vacationId, row.providerEventId]));

    await db.update(vacation).set({ deletedAt: new Date() }).where(eq(vacation.id, cancelled));
    await db
      .update(vacation)
      .set({ vacationType: CalendarRecordType.StudyLeave })
      .where(eq(vacation.id, retyped));
    await db.delete(vacation).where(eq(vacation.id, hardDeleted));
    await syncTarget(configId);

    const deletes = (await calls()).filter((call) => call.operation === "DELETE");
    expect(deletes.map((call) => call.providerEventId).sort()).toEqual(
      [written.get(cancelled), written.get(retyped), written.get(hardDeleted)].sort()
    );
    expect((await ledger()).map((row) => row.vacationId)).toEqual([kept]);
  });

  it("falls back to plain events once when Google refuses the status types", async () => {
    await connect(calendarProvider.Google, `fake-code-${FAKE_PLAIN_MARKER}`);
    await addVacation(day(2));
    await addVacation(day(3), { vacationType: CalendarRecordType.HomeOffice });

    const outcome = await syncTarget(configId);

    expect(outcome).toEqual({ status: "done" });
    const recorded = await calls();
    expect(
      recorded.map((call) => [call.result, (call.payload as { eventType: string }).eventType])
    ).toEqual([
      ["capability_refused", "workingLocation"],
      ["ok", "default"],
    ]);
    expect((await connection())?.capability).toBe(calendarCapability.Plain);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerEventId).toBe(recorded[1]?.providerEventId);
    expect((await target()).lastError).toBeNull();
  });

  it("stops on a revoked grant and marks the connection for reconnecting", async () => {
    await connect(calendarProvider.Google, `fake-code-${FAKE_REVOKED_MARKER}`, false);
    await addVacation(day(2));

    const outcome = await syncTarget(configId);

    expect(outcome).toEqual({ status: "done" });
    expect((await connection())?.status).toBe(calendarConnectionStatus.NeedsReconnect);
    expect(await target()).toMatchObject({ syncDueAt: null, lastError: "auth_revoked" });

    expect(await syncTarget(configId)).toEqual({ status: "done" });
    expect(await calls()).toEqual([]);
  });

  it("reschedules after the provider's Retry-After when throttled, without counting a failure", async () => {
    await connect(calendarProvider.Microsoft);
    await addVacation(day(2));
    failing("insert", { ok: false, error: "throttled", retryAfterSeconds: 42 });

    const outcome = await syncTarget(configId);

    expect(outcome).toEqual({ status: "throttled", retryAfterSeconds: 42 });
    const row = await target();
    expect(row).toMatchObject({ syncAttempts: 0, lastError: "throttled" });
    expect(row.syncDueAt).toBeInstanceOf(Date);
  });

  it("counts any other failure as a failed attempt with the provider's code", async () => {
    await connect(calendarProvider.Google);
    await addVacation(day(2));
    failing("insert", { ok: false, error: "other", reason: "http_500" });

    await syncTarget(configId);
    const second = await syncTarget(configId);

    expect(second).toEqual({ status: "retry", attempts: 2 });
    expect(await target()).toMatchObject({ syncAttempts: 2, lastError: "http_500" });
  });

  it("re-inserts under a new ledger id when the patched event is gone", async () => {
    await connect(calendarProvider.Microsoft);
    const id = await addVacation(day(2));
    await syncTarget(configId);
    const [inserted] = await ledger();

    await db.update(vacation).set({ note: "Moved" }).where(eq(vacation.id, id));
    failing("patch", { ok: false, error: "not_found" });
    await syncTarget(configId);

    const [replaced] = await ledger();
    expect(replaced?.id).not.toBe(inserted?.id);
    expect(replaced?.providerEventId).not.toBe(inserted?.providerEventId);
    const reinsert = (await calls()).at(-1);
    expect(reinsert?.operation).toBe("INSERT");
    expect((reinsert?.payload as { transactionId: string }).transactionId).toBe(replaced?.id);
  });

  it("pauses on a lapsed plan without writing or deleting anything", async () => {
    await connect(calendarProvider.Google);
    await addVacation(day(2));
    await syncTarget(configId);
    await db.update(vacation).set({ deletedAt: new Date() });
    await db.update(calendarSync).set({ syncDueAt: new Date() });
    entitled.value = false;

    const outcome = await syncTarget(configId);

    expect(outcome).toEqual({ status: "done" });
    expect(await calls()).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
    expect(await target()).toMatchObject({ syncDueAt: null, lastError: "plan" });
  });

  it("waits while another instance holds the connection's lease, and takes an expired one", async () => {
    await connect(calendarProvider.Google);
    await addVacation(day(2));
    const holdLease = (ms: number) =>
      db
        .update(calendarConnection)
        .set({ syncLeaseUntil: new Date(Date.now() + ms) })
        .where(eq(calendarConnection.id, connectionId));

    await holdLease(5 * 60 * 1000);
    expect(await syncTarget(configId)).toEqual({ status: "busy" });
    expect(await calls()).toEqual([]);
    expect((await target()).syncAttempts).toBe(0);

    await holdLease(-1000);
    expect(await syncTarget(configId)).toEqual({ status: "done" });
    expect(await calls()).toHaveLength(1);
    expect((await connection())?.syncLeaseUntil).toBeNull();
  });

  it("clears the due marker of a target whose connection was revoked", async () => {
    await connect(calendarProvider.Google);
    await db
      .update(calendarConnection)
      .set({ revokedAt: new Date() })
      .where(eq(calendarConnection.id, connectionId));

    expect(await syncTarget(configId)).toEqual({ status: "done" });
    expect((await target()).syncDueAt).toBeNull();
  });

  it("purges exactly the ledger's events and switches the target off", async () => {
    await connect(calendarProvider.Google);
    await addVacation(day(2));
    await addVacation(day(3));
    await syncTarget(configId);
    const written = (await ledger()).map((row) => row.providerEventId).sort();
    await db.insert(calendarSyncEvents).values({
      id: uuidv4(),
      calendarSyncId: configId,
      kind: calendarSyncEventKind.Absence,
      contentHash: "never-confirmed",
    });

    await purgeTarget(configId);

    const deletes = (await calls()).filter((call) => call.operation === "DELETE");
    expect(deletes.map((call) => call.providerEventId).sort()).toEqual(written);
    expect(await ledger()).toEqual([]);
    expect(await target()).toMatchObject({
      connectionId: null,
      timeZone: null,
      syncDueAt: null,
      lastSyncedAt: null,
    });
    expect(await connection()).toMatchObject({ syncLeaseUntil: null });
  });

  it("retries a failing delete during a purge", async () => {
    await connect(calendarProvider.Google);
    await addVacation(day(2));
    await syncTarget(configId);
    let failures = 2;
    driverOverride.value = (driver) => ({
      ...driver,
      delete: (context, providerEventId) =>
        failures-- > 0
          ? Promise.resolve({ ok: false, error: "throttled", retryAfterSeconds: 0 })
          : driver.delete(context, providerEventId),
    });

    await purgeTarget(configId);

    expect(await operations()).toEqual(["INSERT", "DELETE"]);
    expect(await ledger()).toEqual([]);
  });

  it("keeps the rows whose delete keeps failing and still switches the target off", async () => {
    await connect(calendarProvider.Google);
    await addVacation(day(2));
    await syncTarget(configId);
    const [written] = await ledger();
    failing("delete", { ok: false, error: "throttled", retryAfterSeconds: 0 });

    await purgeTarget(configId);

    expect((await ledger()).map((row) => row.id)).toEqual([written?.id]);
    expect((await target()).connectionId).toBeNull();
  });

  it("purges locally when the connection needs reconnecting", async () => {
    await connect(calendarProvider.Google);
    await addVacation(day(2));
    await syncTarget(configId);
    await db
      .update(calendarConnection)
      .set({ status: calendarConnectionStatus.NeedsReconnect })
      .where(eq(calendarConnection.id, connectionId));

    await purgeTarget(configId);

    expect(await operations()).toEqual(["INSERT"]);
    expect(await ledger()).toEqual([]);
    expect((await target()).connectionId).toBeNull();
  });

  it("purges locally when the provider is switched off", async () => {
    await connect(calendarProvider.Microsoft);
    await addVacation(day(2));
    await syncTarget(configId);
    driverOverride.value = () => undefined;

    await purgeTarget(configId);

    expect(await calls()).toHaveLength(1);
    expect(await ledger()).toEqual([]);
    expect((await target()).connectionId).toBeNull();
  });

  it("purges locally when no token can be had", async () => {
    await connect(calendarProvider.Google);
    await addVacation(day(2));
    await syncTarget(configId);
    await db
      .update(calendarConnection)
      .set({
        refreshTokenEnc: await encryptOAuthToken(`fake-refresh-google-${FAKE_REVOKED_MARKER}`),
        accessTokenExpiresAt: new Date(Date.now() - HOUR_MS),
      })
      .where(eq(calendarConnection.id, connectionId));

    await purgeTarget(configId);

    expect(await operations()).toEqual(["INSERT"]);
    expect(await ledger()).toEqual([]);
    expect((await target()).connectionId).toBeNull();
  });
});
