import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { inArray, isNotNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/db.js";
import { cleanupTestData, createTestUser } from "./helpers/testSetup.js";
import {
  calendarSync,
  calendarSyncScope,
  calendarSyncTypes,
} from "../../db/schema/calendar-sync-schema.js";
import {
  calendarConnection,
  calendarConnectionStatus,
  calendarProvider,
} from "../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { markCalendarTargetsDirty } from "../../services/calendarSync/markCalendarTargetsDirty.js";
import {
  createSyncQueue,
  installCalendarSyncQueue,
} from "../../services/calendarSync/enqueueSync.js";
import type { SyncOutcome } from "../../services/calendarSync/types.js";

describe("markCalendarTargetsDirty", () => {
  const ids: Record<string, string> = {};
  const approvedAt = new Date();
  let alice: string;
  let bob: string;

  const connection = async (userId: string, status = calendarConnectionStatus.Active) => {
    const id = uuidv4();
    await db.insert(calendarConnection).values({
      id,
      userId,
      provider:
        status === calendarConnectionStatus.Active
          ? calendarProvider.Google
          : calendarProvider.Microsoft,
      refreshTokenEnc: "unused",
      grantedScopes: "calendar",
      status,
    });
    return id;
  };

  const config = async (
    name: string,
    userId: string,
    scope: calendarSyncScope,
    connectionId: string | null,
    types: CalendarRecordType[]
  ) => {
    const id = uuidv4();
    await db.insert(calendarSync).values({
      id,
      userId,
      name,
      scope,
      token: `flx_live_${uuidv4().replaceAll("-", "")}`,
      connectionId,
      timeZone: "Europe/Prague",
    });
    await db.insert(calendarSyncTypes).values(
      types.map((vacationType) => ({
        id: uuidv4(),
        calendarSyncId: id,
        vacationType,
        color: "teal",
      }))
    );
    ids[name] = id;
  };

  const due = async () =>
    (
      await db
        .select({ id: calendarSync.id })
        .from(calendarSync)
        .where(isNotNull(calendarSync.syncDueAt))
    ).map((row) => row.id);

  beforeAll(async () => {
    await cleanupTestData();
    alice = (await createTestUser("mark-dirty-alice@test.com", "Alice", "pw")).id;
    bob = (await createTestUser("mark-dirty-bob@test.com", "Bob", "pw")).id;
    const aliceGoogle = await connection(alice);
    const aliceBroken = await connection(alice, calendarConnectionStatus.NeedsReconnect);
    const bobGoogle = await connection(bob);

    await config("alice vacation", alice, calendarSyncScope.Me, aliceGoogle, [
      CalendarRecordType.Vacation,
      CalendarRecordType.Sick,
    ]);
    await config("alice home office", alice, calendarSyncScope.Me, aliceGoogle, [
      CalendarRecordType.HomeOffice,
    ]);
    await config("alice not connected", alice, calendarSyncScope.Me, null, [
      CalendarRecordType.Vacation,
    ]);
    await config("alice broken", alice, calendarSyncScope.Me, aliceBroken, [
      CalendarRecordType.Vacation,
    ]);
    await config("alice team", alice, calendarSyncScope.Team, null, [CalendarRecordType.Vacation]);
    await config("bob vacation", bob, calendarSyncScope.Me, bobGoogle, [
      CalendarRecordType.Vacation,
    ]);
  });

  afterEach(async () => {
    installCalendarSyncQueue(undefined);
    await db
      .update(calendarSync)
      .set({ syncDueAt: null })
      .where(inArray(calendarSync.id, Object.values(ids)));
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("marks only the owner's connected ME targets whose types include the row's type", async () => {
    await markCalendarTargetsDirty([
      { userId: alice, vacationType: CalendarRecordType.Vacation, approvedAt },
    ]);

    expect(await due()).toEqual([ids["alice vacation"]]);
  });

  it("marks each owner's targets for a batch across users and types, and enqueues them", async () => {
    const run = vi.fn((): Promise<SyncOutcome> => Promise.resolve({ status: "done" }));
    const queue = createSyncQueue({ run });
    installCalendarSyncQueue(queue);

    await markCalendarTargetsDirty([
      { userId: alice, vacationType: CalendarRecordType.HomeOffice, approvedAt },
      { userId: alice, vacationType: CalendarRecordType.HomeOffice, approvedAt },
      { userId: bob, vacationType: CalendarRecordType.Vacation, approvedAt },
      { userId: bob, vacationType: CalendarRecordType.Sick, approvedAt },
    ]);
    await queue.drain();

    const expected = [ids["alice home office"], ids["bob vacation"]].sort();
    expect((await due()).sort()).toEqual(expected);
    expect(run.mock.calls.map(([id]) => id).sort()).toEqual(expected);
  });

  it("marks nothing for a row that was never approved", async () => {
    await markCalendarTargetsDirty([
      { userId: alice, vacationType: CalendarRecordType.Vacation, approvedAt: null },
    ]);

    expect(await due()).toEqual([]);
  });

  it("marks nothing for a type no connected target carries", async () => {
    await markCalendarTargetsDirty([
      { userId: bob, vacationType: CalendarRecordType.HomeOffice, approvedAt },
    ]);

    expect(await due()).toEqual([]);
  });
});
