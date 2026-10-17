import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/db.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import {
  cleanupTestData,
  createTestGroup,
  createTestUser,
  createTestVacation,
} from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import {
  calendarSync,
  calendarSyncScope,
  calendarSyncTypes,
} from "../../db/schema/calendar-sync-schema.js";
import {
  calendarConnection,
  calendarSyncFakeEvents,
} from "../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType, vacation } from "../../db/schema/vacation-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import {
  createSyncQueue,
  installCalendarSyncQueue,
  type SyncQueue,
} from "../../services/calendarSync/enqueueSync.js";
import { syncTarget } from "../../services/calendarSync/syncEngine.js";

const NEXT_YEAR = new Date().getUTCFullYear() + 1;

describe("an approval reaches the owner's connected calendar", () => {
  let server: LoopbackServer;
  let queue: SyncQueue;
  let ownerId: string;
  let teammateId: string;
  let groupId: string;
  let configId: string;
  let connectionId: string;
  let ownerCookie: string;
  let approverCookie: string;

  const fakeEvents = () =>
    db
      .select()
      .from(calendarSyncFakeEvents)
      .where(eq(calendarSyncFakeEvents.connectionId, connectionId))
      .orderBy(asc(calendarSyncFakeEvents.createdAt));

  const installQueue = () => {
    queue = createSyncQueue({ run: (id) => syncTarget(id), coalesceMs: 0 });
    installCalendarSyncQueue(queue);
  };

  const approve = (vacationId: string) =>
    request(server.url).post(`/api/vacation/approve/${vacationId}`).set("Cookie", approverCookie);

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
    installQueue();

    ownerId = (await createTestUser("sync-approval-owner@test.com", "Owner", "pw")).id;
    teammateId = (await createTestUser("sync-approval-mate@test.com", "Teammate", "pw")).id;
    const approverId = (await createTestUser("sync-approval-approver@test.com", "Approver", "pw"))
      .id;
    groupId = (await createTestGroup("Synced team", ownerId, approverId)).id;
    await db.insert(groupUsers).values([
      { id: uuidv4(), userId: ownerId, groupId, viewAccess: true },
      { id: uuidv4(), userId: teammateId, groupId, viewAccess: true },
    ]);
    await upsertSubscription((await ensureOrganizationForUser(ownerId)).id, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
    });

    configId = uuidv4();
    await db.insert(calendarSync).values({
      id: configId,
      userId: ownerId,
      name: "Mine",
      scope: calendarSyncScope.Me,
      token: `flx_live_${uuidv4().replaceAll("-", "")}`,
    });
    await db.insert(calendarSyncTypes).values(
      [CalendarRecordType.Vacation, CalendarRecordType.HomeOffice].map((vacationType) => ({
        id: uuidv4(),
        calendarSyncId: configId,
        vacationType,
        color: "violet",
      }))
    );

    ownerCookie = await authCookieFor(ownerId);
    approverCookie = await authCookieFor(approverId);

    const start = await request(server.url)
      .post("/api/calendar-sync/connections/google/start")
      .set("Cookie", ownerCookie)
      .send({ configId, timeZone: "Europe/Prague" });
    const consent = new URL(start.body.url);
    await request(server.url).get(`${consent.pathname}${consent.search}`).expect(302);
    connectionId = (
      await db.select().from(calendarConnection).where(eq(calendarConnection.userId, ownerId))
    )[0]!.id;
    await queue.drain();
  });

  afterAll(async () => {
    installCalendarSyncQueue(undefined);
    await server?.close();
    await cleanupTestData();
  });

  it("writes the approved day into the owner's calendar through the fake driver", async () => {
    const vacationId = await createTestVacation(ownerId, groupId, `${NEXT_YEAR}-04-07`);

    await approve(vacationId).expect(200);
    await queue.drain();

    const events = await fakeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "GOOGLE",
      operation: "INSERT",
      result: "ok",
      payload: {
        eventType: "workingLocation",
        summary: "Vacation",
        start: { date: `${NEXT_YEAR}-04-07` },
        end: { date: `${NEXT_YEAR}-04-08` },
        workingLocationProperties: {
          type: "customLocation",
          customLocation: { label: "Vacation" },
        },
        extendedProperties: {
          private: { flexiDayVacationId: vacationId, flexiDayConfigId: configId },
        },
      },
    });
    const [target] = await db.select().from(calendarSync).where(eq(calendarSync.id, configId));
    expect(target).toMatchObject({ syncDueAt: null, lastError: null });
  });

  it("deletes the event when the approved day is cancelled", async () => {
    const vacationId = await createTestVacation(ownerId, groupId, `${NEXT_YEAR}-04-14`);
    await approve(vacationId).expect(200);
    await queue.drain();
    const inserted = (await fakeEvents()).at(-1)!;

    await request(server.url)
      .delete(`/api/vacation/${vacationId}`)
      .set("Cookie", approverCookie)
      .send({})
      .expect(200);
    await queue.drain();

    const deleted = (await fakeEvents()).at(-1)!;
    expect(deleted).toMatchObject({
      operation: "DELETE",
      result: "ok",
      providerEventId: inserted.providerEventId,
    });
  });

  it("never touches the owner's calendar for a teammate's approval", async () => {
    const before = await fakeEvents();
    const vacationId = await createTestVacation(teammateId, groupId, `${NEXT_YEAR}-04-21`);

    await approve(vacationId).expect(200);
    await queue.drain();

    expect(await fakeEvents()).toEqual(before);
  });

  it("marks the target due when its type list changes, and removes events of a dropped type", async () => {
    const vacationId = await createTestVacation(ownerId, groupId, `${NEXT_YEAR}-04-28`);
    await approve(vacationId).expect(200);
    await queue.drain();
    const before = await fakeEvents();
    const deletedBefore = new Set(
      before.filter((e) => e.operation === "DELETE").map((e) => e.providerEventId)
    );
    const live = before
      .filter((e) => e.operation === "INSERT" && !deletedBefore.has(e.providerEventId))
      .map((e) => e.providerEventId);
    expect(live).toHaveLength(2);

    const res = await request(server.url)
      .put(`/api/calendar-sync/${configId}`)
      .set("Cookie", ownerCookie)
      .send({
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [{ type: "HOME_OFFICE", color: "violet" }],
      })
      .expect(200);
    expect(res.body.target.syncing).toBe(true);
    await queue.drain();

    // The ledger is read in no fixed order, so the deletes may land either way round.
    const after = (await fakeEvents()).slice(before.length);
    expect(after.every((e) => e.operation === "DELETE" && e.result === "ok")).toBe(true);
    expect(after.map((e) => e.providerEventId).sort()).toEqual([...live].sort());
  });

  it("leaves the target alone when a pending request is rejected", async () => {
    const vacationId = await createTestVacation(ownerId, groupId, `${NEXT_YEAR}-05-12`);
    await db
      .update(calendarSyncTypes)
      .set({ vacationType: CalendarRecordType.Vacation })
      .where(eq(calendarSyncTypes.calendarSyncId, configId));

    await request(server.url)
      .post(`/api/vacation/reject/${vacationId}`)
      .set("Cookie", approverCookie)
      .send({ reason: "short-staffed" })
      .expect(200);

    const [target] = await db.select().from(calendarSync).where(eq(calendarSync.id, configId));
    expect(target?.syncDueAt).toBeNull();
  });

  it("still answers 200 to an approval when the sync queue throws", async () => {
    installCalendarSyncQueue({
      enqueue: () => {
        throw new Error("queue down");
      },
      drain: () => Promise.resolve(),
      stop: () => undefined,
    });
    await db.delete(calendarSyncTypes).where(eq(calendarSyncTypes.calendarSyncId, configId));
    await db.insert(calendarSyncTypes).values({
      id: uuidv4(),
      calendarSyncId: configId,
      vacationType: CalendarRecordType.Vacation,
      color: "violet",
    });
    const vacationId = await createTestVacation(ownerId, groupId, `${NEXT_YEAR}-05-05`);

    try {
      await approve(vacationId).expect(200);
    } finally {
      installQueue();
    }

    const [row] = await db.select().from(vacation).where(eq(vacation.id, vacationId));
    expect(row?.approvedAt).toBeInstanceOf(Date);
    const [target] = await db.select().from(calendarSync).where(eq(calendarSync.id, configId));
    expect(target?.syncDueAt).toBeInstanceOf(Date);
  });
});
