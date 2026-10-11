import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { setupTestEnvironment, cleanupTestData, type TestContext } from "./helpers/testSetup.js";
import { db } from "../../db/db.js";
import { calendarSync, calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import {
  calendarConnection,
  calendarProvider,
  calendarSyncEventKind,
  calendarSyncEvents,
} from "../../db/schema/calendar-connection-schema.js";
import { vacation, CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { attachTarget } from "../../services/calendarConnection/calendarConnectionServices.js";
import { CALENDAR_SYNC_TEAM_SCOPE } from "../../services/calendarConnection/types.js";

const pgCode = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return ((error as { cause?: { code?: string } }).cause ?? (error as { code?: string })).code;
  }
  throw new Error("expected the database to refuse");
};

const insertConfig = async (userId: string, scope: calendarSyncScope) => {
  const id = uuidv4();
  await db.insert(calendarSync).values({
    id,
    userId,
    name: `${scope} calendar`,
    scope,
    token: `flx_live_${uuidv4().replaceAll("-", "")}`,
  });
  return id;
};

const insertConnection = (userId: string) =>
  db
    .insert(calendarConnection)
    .values({
      id: uuidv4(),
      userId,
      provider: calendarProvider.Google,
      refreshTokenEnc: "encrypted-refresh-token",
      grantedScopes: "https://www.googleapis.com/auth/calendar.events.owned",
    })
    .returning();

describe("Calendar direct sync data model E2E", () => {
  let context: TestContext;
  let connectionId: string;
  let meConfigId: string;
  let teamConfigId: string;

  beforeAll(async () => {
    context = await setupTestEnvironment();
    const [connection] = await insertConnection(context.user1.id);
    connectionId = connection!.id;
    meConfigId = await insertConfig(context.user1.id, calendarSyncScope.Me);
    teamConfigId = await insertConfig(context.user1.id, calendarSyncScope.Team);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("refuses to attach a TEAM config and leaves it untouched", async () => {
    await expect(
      attachTarget({
        configId: teamConfigId,
        userId: context.user1.id,
        connectionId,
        timeZone: "Europe/Prague",
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      errors: [expect.objectContaining({ publicContext: { code: CALENDAR_SYNC_TEAM_SCOPE } })],
    });

    const [row] = await db.select().from(calendarSync).where(eq(calendarSync.id, teamConfigId));
    expect(row?.connectionId).toBeNull();
    expect(row?.syncDueAt).toBeNull();
  });

  it("holds the rule in the database too", async () => {
    const code = await pgCode(
      db.update(calendarSync).set({ connectionId }).where(eq(calendarSync.id, teamConfigId))
    );
    expect(code).toBe("23514");
  });

  it("attaches a ME config with its zone and marks it due", async () => {
    const row = await attachTarget({
      configId: meConfigId,
      userId: context.user1.id,
      connectionId,
      timeZone: "Europe/Prague",
    });

    expect(row.connectionId).toBe(connectionId);
    expect(row.timeZone).toBe("Europe/Prague");
    expect(row.syncDueAt).toBeInstanceOf(Date);
    expect(row.syncAttempts).toBe(0);
  });

  it("answers 404 for another user's config", async () => {
    await expect(
      attachTarget({
        configId: meConfigId,
        userId: context.user2.id,
        connectionId,
        timeZone: "Europe/Prague",
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps one live connection per user and provider", async () => {
    expect(await pgCode(insertConnection(context.user1.id))).toBe("23505");

    await db
      .update(calendarConnection)
      .set({ revokedAt: new Date() })
      .where(eq(calendarConnection.id, connectionId));
    const [revived] = await insertConnection(context.user1.id);
    expect(revived?.id).toBeDefined();
  });

  it("keeps one ledger row per target and vacation, and outlives a hard-deleted vacation", async () => {
    const vacationId = uuidv4();
    await db.insert(vacation).values({
      id: vacationId,
      userId: context.user1.id,
      groupId: context.group.id,
      requestId: uuidv4(),
      requestedDay: "2030-01-07",
      vacationType: CalendarRecordType.Vacation,
      approvedAt: new Date(),
    });
    const ledgerRow = () => ({
      id: uuidv4(),
      calendarSyncId: meConfigId,
      vacationId,
      kind: calendarSyncEventKind.Absence,
      contentHash: "hash",
    });

    const first = ledgerRow();
    await db.insert(calendarSyncEvents).values(first);
    expect(await pgCode(db.insert(calendarSyncEvents).values(ledgerRow()))).toBe("23505");

    await db.delete(vacation).where(eq(vacation.id, vacationId));
    const [orphan] = await db
      .select()
      .from(calendarSyncEvents)
      .where(eq(calendarSyncEvents.id, first.id));
    expect(orphan?.vacationId).toBeNull();
  });

  it("detaches the target when its connection is deleted", async () => {
    const [attached] = await db
      .select({ connectionId: calendarSync.connectionId })
      .from(calendarSync)
      .where(eq(calendarSync.id, meConfigId));
    await db.delete(calendarConnection).where(eq(calendarConnection.id, attached!.connectionId!));

    const [row] = await db.select().from(calendarSync).where(eq(calendarSync.id, meConfigId));
    expect(row?.connectionId).toBeNull();
  });
});
