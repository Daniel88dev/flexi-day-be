import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addMember,
  makeGroup,
  makeUser,
  removeMember,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { groupEventRepeatFreq, groupEvents } from "../../db/schema/group-event-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { calendarSync, calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import {
  calendarConnection,
  calendarProvider,
  calendarSyncEventKind,
  calendarSyncEvents,
  calendarSyncFakeEvents,
} from "../../db/schema/calendar-connection-schema.js";
import { encryptOAuthToken } from "../../utils/oauthTokens.js";
import { generateInviteCode } from "../../utils/inviteCode.js";
import { syncTarget } from "../../services/calendarSync/syncEngine.js";
import {
  createSyncQueue,
  installCalendarSyncQueue,
} from "../../services/calendarSync/enqueueSync.js";

vi.mock("../../services/calendarConnection/entitlement.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/calendarConnection/entitlement.js")>()),
  isCalendarSyncEntitled: () => Promise.resolve(true),
}));

const HOUR_MS = 60 * 60 * 1000;

const makePaid = async (managerId: string) =>
  upsertSubscription((await ensureOrganizationForUser(managerId)).id, {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });

const vevents = (body: string) =>
  body
    .split("BEGIN:VEVENT\r\n")
    .slice(1)
    .map((block) => block.split("\r\nEND:VEVENT")[0]!.split("\r\n"));

const line = (event: string[], name: string) =>
  event.find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

/** Tuesdays 09:00 to 10:00 from 5 January 2027 until 29 June 2027. */
const WEEKLY = {
  title: "Team retro",
  note: "Bring notes",
  startDate: "2027-01-05",
  endDate: "2027-01-05",
  startTime: "09:00",
  endTime: "10:00",
  repeat: { freq: "weekly", interval: 1, weekdays: [1], monthlyMode: null, until: "2027-06-29" },
};

const insertEvent = async (
  groupId: string,
  values: Partial<typeof groupEvents.$inferInsert> = {}
): Promise<string> => {
  const id = uuidv4();
  await db.insert(groupEvents).values({
    id,
    groupId,
    title: "Offsite",
    startDate: "2027-03-10",
    endDate: "2027-03-12",
    ...values,
  });
  return id;
};

describe("group events in feeds and direct sync", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  const feedOf = async (ownerId: string, body: Record<string, unknown>) => {
    const created = await request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", await authCookieFor(ownerId))
      .send(body);
    expect(created.status).toBe(201);
    const token = (created.body.feedUrl as string).match(/(flx_live_[a-f0-9]{40})\.ics$/)![1]!;
    return async () => {
      const response = await request(server.url).get(`/calendars/${token}.ics`).expect(200);
      return { text: response.text, events: vevents(response.text) };
    };
  };

  /**
   * Engineering and Design are paid groups the owner is in; Sales is one the
   * owner left, Marketing one the owner never joined.
   */
  const seedGroups = async () => {
    const manager = await makeUser("Manager");
    const owner = await makeUser("Olivia Owner");
    const alice = await makeUser("Alice");
    const engineering = await makeGroup("Engineering", manager.id);
    const design = await makeGroup("Design", manager.id);
    const sales = await makeGroup("Sales", manager.id);
    const marketing = await makeGroup("Marketing", manager.id);
    await makePaid(manager.id);
    for (const groupId of [engineering, design, sales]) {
      await addMember(groupId, owner.id, { viewAccess: true });
    }
    for (const groupId of [engineering, design, sales, marketing]) {
      await addMember(groupId, alice.id);
    }
    await removeMember(sales, owner.id);
    return { manager, owner, alice, engineering, design, sales, marketing };
  };

  const uids = (events: string[][]) => events.map((event) => line(event, "UID")).sort();

  describe("feeds", () => {
    it("carries the events of every live group on a personal feed, inside the window", async () => {
      const { owner, engineering, design, sales, marketing } = await seedGroups();
      const offsite = await insertEvent(engineering);
      const forever = await insertEvent(design, {
        title: "Weekly sync",
        startDate: "2023-01-02",
        endDate: "2023-01-02",
        repeatFreq: groupEventRepeatFreq.Weekly,
        repeatInterval: 1,
        repeatWeekdays: [0],
      });
      await insertEvent(design, {
        title: "Old one-off",
        startDate: "2024-01-10",
        endDate: "2024-01-10",
      });
      await insertEvent(design, {
        title: "Ended series",
        startDate: "2023-01-02",
        endDate: "2023-01-02",
        repeatFreq: groupEventRepeatFreq.Daily,
        repeatInterval: 1,
        repeatUntil: "2024-06-30",
      });
      await insertEvent(engineering, { title: null, deletedAt: new Date() });
      await insertEvent(sales, { title: "Left group" });
      await insertEvent(marketing, { title: "Never joined" });

      const fetch = await feedOf(owner.id, {
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [],
        includeGroupEvents: true,
      });

      expect(uids((await fetch()).events)).toEqual(
        [`UID:ge-${offsite}@flexiday`, `UID:ge-${forever}@flexiday`].sort()
      );
    });

    it("carries only the selected groups the owner is still in on a team feed", async () => {
      const { owner, engineering, design, sales } = await seedGroups();
      const selected = await insertEvent(engineering);
      await insertEvent(design, { title: "Not selected" });
      await insertEvent(sales, { title: "Left group" });
      await addMember(sales, owner.id);

      const fetch = await feedOf(owner.id, {
        name: "Team",
        scope: "TEAM",
        teamIds: [engineering, sales],
        types: [],
        includeGroupEvents: true,
      });
      expect((await fetch()).events).toHaveLength(2);

      await removeMember(sales, owner.id);
      expect(uids((await fetch()).events)).toEqual([`UID:ge-${selected}@flexiday`]);
    });

    it("writes a timed series in the feed's zone with its rule, skipped date and group line", async () => {
      const { owner, engineering } = await seedGroups();
      const id = await insertEvent(engineering, {
        title: "Team retro",
        note: "Bring notes",
        startDate: "2027-01-05",
        endDate: "2027-01-05",
        startTime: "09:00",
        endTime: "10:00",
        repeatFreq: groupEventRepeatFreq.Weekly,
        repeatInterval: 1,
        repeatWeekdays: [1],
        repeatUntil: "2027-06-29",
        skippedDates: ["2027-02-09"],
      });

      const fetch = await feedOf(owner.id, {
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [{ type: "VACATION", color: "blue" }],
        includeGroupEvents: true,
        timeZone: "America/New_York",
      });
      const { text, events } = await fetch();

      expect(text).toContain("BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\n");
      const [event] = events;
      expect(event).toEqual([
        `UID:ge-${id}@flexiday`,
        expect.stringMatching(/^DTSTAMP:/),
        "DTSTART;TZID=America/New_York:20270105T090000",
        "DTEND;TZID=America/New_York:20270105T100000",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270629T130000Z",
        "EXDATE;TZID=America/New_York:20270209T090000",
        "SUMMARY:Team retro",
        "DESCRIPTION:Bring notes\\nGroup: Engineering",
        "TRANSP:TRANSPARENT",
      ]);
    });

    it("writes an all-day run of days and names the group in the owner's language", async () => {
      const { owner, engineering } = await seedGroups();
      await insertEvent(engineering);
      await request(server.url)
        .put("/api/users/me/settings")
        .set("Cookie", await authCookieFor(owner.id))
        .send({ language: "cs" })
        .expect(200);

      const fetch = await feedOf(owner.id, {
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [],
        includeGroupEvents: true,
      });
      const [event] = (await fetch()).events;

      expect(line(event!, "DTSTART")).toBe("DTSTART;VALUE=DATE:20270310");
      expect(line(event!, "DTEND")).toBe("DTEND;VALUE=DATE:20270313");
      expect(line(event!, "SUMMARY")).toBe("SUMMARY:Offsite");
      expect(line(event!, "DESCRIPTION")).toBe("DESCRIPTION:Skupina: Engineering");
    });

    it("carries no group event while the Group events row is off", async () => {
      const { owner, engineering } = await seedGroups();
      await insertEvent(engineering);

      const fetch = await feedOf(owner.id, {
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [{ type: "VACATION", color: "blue" }],
      });

      expect((await fetch()).events).toEqual([]);
    });
  });

  describe("direct sync on the fake driver", () => {
    let queue: ReturnType<typeof createSyncQueue>;

    const connect = async (
      ownerId: string,
      provider: calendarProvider,
      options: { timeZone?: string; includeGroupEvents?: boolean } = {}
    ) => {
      const slug = provider.toLowerCase();
      const connectionId = uuidv4();
      await db.insert(calendarConnection).values({
        id: connectionId,
        userId: ownerId,
        provider,
        refreshTokenEnc: await encryptOAuthToken(`fake-refresh-${slug}-fake-code`),
        accessTokenEnc: await encryptOAuthToken(`fake-access-${slug}-fake-code`),
        accessTokenExpiresAt: new Date(Date.now() + HOUR_MS),
        grantedScopes: "calendar",
      });
      const configId = uuidv4();
      await db.insert(calendarSync).values({
        id: configId,
        userId: ownerId,
        name: "Mine",
        scope: calendarSyncScope.Me,
        token: `flx_live_${uuidv4().replaceAll("-", "")}`,
        connectionId,
        timeZone: options.timeZone ?? "Europe/Prague",
        includeGroupEvents: options.includeGroupEvents ?? true,
      });

      const calls = async () =>
        (
          await db
            .select()
            .from(calendarSyncFakeEvents)
            .where(eq(calendarSyncFakeEvents.connectionId, connectionId))
            .orderBy(asc(calendarSyncFakeEvents.createdAt))
        ).map((call) => ({ ...call, payload: call.payload as Record<string, unknown> | null }));
      const ledger = () =>
        db.select().from(calendarSyncEvents).where(eq(calendarSyncEvents.calendarSyncId, configId));
      return { configId, calls, ledger };
    };

    const createEvent = async (userId: string, groupId: string, body = WEEKLY): Promise<string> => {
      const response = await request(server.url)
        .post("/api/group-events")
        .set("Cookie", await authCookieFor(userId))
        .send({ groupId, ...body })
        .expect(201);
      return response.body.id as string;
    };

    const deleteEvent = async (userId: string, id: string, query: string) =>
      request(server.url)
        .delete(`/api/group-events/${id}?${query}`)
        .set("Cookie", await authCookieFor(userId))
        .expect(200);

    beforeEach(() => {
      // Uninstalling stops a queue for good, so each case gets its own.
      queue = createSyncQueue({ run: (id) => syncTarget(id) });
      installCalendarSyncQueue(queue);
    });

    afterEach(() => {
      installCalendarSyncQueue(undefined);
    });

    it("inserts a teammate's weekly series once, patches Google's recurrence for a skipped date and deletes it", async () => {
      const { owner, alice, engineering } = await seedGroups();
      const target = await connect(owner.id, calendarProvider.Google);

      const id = await createEvent(alice.id, engineering);
      await queue.drain();
      await syncTarget(target.configId);

      const [inserted] = await target.calls();
      expect((await target.calls()).map((call) => call.operation)).toEqual(["INSERT"]);
      expect(inserted?.payload).toMatchObject({
        eventType: "default",
        summary: "Team retro",
        transparency: "transparent",
        start: { dateTime: "2027-01-05T09:00:00", timeZone: "Europe/Prague" },
        end: { dateTime: "2027-01-05T10:00:00", timeZone: "Europe/Prague" },
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270629T070000Z"],
        extendedProperties: { private: { flexiDaySourceKey: `ge:${id}` } },
      });
      expect(await target.ledger()).toEqual([
        expect.objectContaining({
          sourceKey: `ge:${id}`,
          groupEventId: id,
          vacationId: null,
          kind: calendarSyncEventKind.GroupEvent,
          eventType: "default",
        }),
      ]);

      await deleteEvent(alice.id, id, "scope=this&occurrenceDate=2027-02-09");
      await queue.drain();

      const afterSkip = await target.calls();
      expect(afterSkip.map((call) => call.operation)).toEqual(["INSERT", "PATCH"]);
      expect(afterSkip[1]?.providerEventId).toBe(inserted?.providerEventId);
      expect(afterSkip[1]?.payload?.recurrence).toEqual([
        "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270629T070000Z",
        "EXDATE;TZID=Europe/Prague:20270209T090000",
      ]);

      await deleteEvent(alice.id, id, "scope=all");
      await queue.drain();

      expect((await target.calls()).map((call) => [call.operation, call.providerEventId])).toEqual([
        ["INSERT", inserted?.providerEventId],
        ["PATCH", inserted?.providerEventId],
        ["DELETE", inserted?.providerEventId],
      ]);
      expect(await target.ledger()).toEqual([]);
    });

    it("re-inserts the series on Microsoft and cancels each skipped date, in the target's zone", async () => {
      const { owner, alice, engineering } = await seedGroups();
      const target = await connect(owner.id, calendarProvider.Microsoft, {
        timeZone: "America/New_York",
      });

      const id = await createEvent(alice.id, engineering);
      await queue.drain();

      const [inserted] = await target.calls();
      expect((await target.calls()).map((call) => call.operation)).toEqual(["INSERT"]);
      expect(inserted?.payload).toMatchObject({
        subject: "Team retro",
        showAs: "free",
        isAllDay: false,
        start: { dateTime: "2027-01-05T09:00:00", timeZone: "America/New_York" },
        end: { dateTime: "2027-01-05T10:00:00", timeZone: "America/New_York" },
        recurrence: {
          pattern: { type: "weekly", interval: 1, daysOfWeek: ["tuesday"] },
          range: { type: "endDate", startDate: "2027-01-05", endDate: "2027-06-29" },
        },
      });

      await deleteEvent(alice.id, id, "scope=this&occurrenceDate=2027-02-09");
      await queue.drain();
      await syncTarget(target.configId);

      const calls = await target.calls();
      expect(calls.map((call) => call.operation)).toEqual(["INSERT", "DELETE", "INSERT", "CANCEL"]);
      expect(calls[1]?.providerEventId).toBe(inserted?.providerEventId);
      expect(calls[3]?.providerEventId).toBe(calls[2]?.providerEventId);
      expect(calls[3]?.payload).toEqual({ date: "2027-02-09" });
      const [row] = await target.ledger();
      expect(row?.providerEventId).toBe(calls[2]?.providerEventId);

      await deleteEvent(alice.id, id, "scope=all");
      await queue.drain();

      expect((await target.calls()).at(-1)).toMatchObject({
        operation: "DELETE",
        providerEventId: calls[2]?.providerEventId,
      });
      expect(await target.ledger()).toEqual([]);
    });

    it("patches a Microsoft series in place when only its title changes, skipped dates kept", async () => {
      const { owner, alice, engineering } = await seedGroups();
      const target = await connect(owner.id, calendarProvider.Microsoft);
      const id = await createEvent(alice.id, engineering);
      await queue.drain();
      const [inserted] = await target.calls();

      await request(server.url)
        .patch(`/api/group-events/${id}`)
        .set("Cookie", await authCookieFor(alice.id))
        .send({ scope: "all", changes: { title: "Retro" } })
        .expect(200);
      await queue.drain();

      expect((await target.calls()).map((call) => [call.operation, call.providerEventId])).toEqual([
        ["INSERT", inserted?.providerEventId],
        ["PATCH", inserted?.providerEventId],
      ]);

      await deleteEvent(alice.id, id, "scope=this&occurrenceDate=2027-02-09");
      await queue.drain();
      const replaced = (await target.calls()).slice(2);
      expect(replaced.map((call) => call.operation)).toEqual(["DELETE", "INSERT", "CANCEL"]);

      await request(server.url)
        .patch(`/api/group-events/${id}`)
        .set("Cookie", await authCookieFor(alice.id))
        .send({ scope: "all", changes: { title: "Team retro" } })
        .expect(200);
      await queue.drain();

      const last = (await target.calls()).slice(5);
      expect(last.map((call) => [call.operation, call.providerEventId])).toEqual([
        ["PATCH", replaced[1]?.providerEventId],
      ]);
      expect(last[0]?.payload).toMatchObject({ subject: "Team retro" });
      const [row] = await target.ledger();
      expect(row?.providerEventId).toBe(replaced[1]?.providerEventId);
    });

    it("replaces a Microsoft series again on the next sync when its cancels did not all land", async () => {
      const { owner, alice, engineering } = await seedGroups();
      const target = await connect(owner.id, calendarProvider.Microsoft);
      const id = await createEvent(alice.id, engineering);
      await deleteEvent(alice.id, id, "scope=this&occurrenceDate=2027-02-09");
      await queue.drain();
      await syncTarget(target.configId);
      const settled = (await target.calls()).length;

      // What a failed cancel leaves behind.
      await db
        .update(calendarSyncEvents)
        .set({ contentHash: "cancels-pending:" })
        .where(eq(calendarSyncEvents.calendarSyncId, target.configId));
      await syncTarget(target.configId);

      const retried = (await target.calls()).slice(settled);
      expect(retried.map((call) => [call.operation, call.payload?.date])).toEqual([
        ["DELETE", undefined],
        ["INSERT", undefined],
        ["CANCEL", "2027-02-09"],
      ]);
    });

    it("cancels the skipped dates of a series already holding some when it first goes to Microsoft", async () => {
      const { owner, engineering } = await seedGroups();
      await insertEvent(engineering, {
        title: "Team retro",
        startDate: "2027-01-05",
        endDate: "2027-01-05",
        repeatFreq: groupEventRepeatFreq.Weekly,
        repeatInterval: 1,
        repeatWeekdays: [1],
        skippedDates: ["2027-01-19", "2027-01-12"],
      });
      const target = await connect(owner.id, calendarProvider.Microsoft);

      await syncTarget(target.configId);
      await syncTarget(target.configId);

      const calls = await target.calls();
      expect(calls.map((call) => [call.operation, call.payload?.date])).toEqual([
        ["INSERT", undefined],
        ["CANCEL", "2027-01-12"],
        ["CANCEL", "2027-01-19"],
      ]);
    });

    it("deletes a group's events from a removed member's target and writes them when they join again", async () => {
      const { manager, owner, alice, engineering } = await seedGroups();
      const target = await connect(owner.id, calendarProvider.Google);
      const id = await createEvent(alice.id, engineering);
      await queue.drain();
      expect((await target.ledger()).map((row) => row.sourceKey)).toEqual([`ge:${id}`]);

      await request(server.url)
        .delete(`/api/group-user/${engineering}/${owner.id}`)
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);
      await queue.drain();

      expect((await target.calls()).map((call) => call.operation)).toEqual(["INSERT", "DELETE"]);
      expect(await target.ledger()).toEqual([]);

      const code = generateInviteCode();
      await db.insert(inviteLink).values({
        id: uuidv4(),
        groupId: engineering,
        code,
        email: null,
        invitedByUserId: manager.id,
        expiresAt: new Date(Date.now() + 24 * HOUR_MS),
      });
      await request(server.url)
        .post(`/api/group-user/code/${code}`)
        .set("Cookie", await authCookieFor(owner.id))
        .expect(201);
      await queue.drain();

      expect((await target.calls()).map((call) => call.operation)).toEqual([
        "INSERT",
        "DELETE",
        "INSERT",
      ]);
      expect((await target.ledger()).map((row) => row.sourceKey)).toEqual([`ge:${id}`]);
    });

    it("never touches a target with Group events off or one of someone outside the group", async () => {
      const { manager, owner, alice, engineering } = await seedGroups();
      const off = await connect(owner.id, calendarProvider.Google, { includeGroupEvents: false });
      const outsider = await connect(manager.id, calendarProvider.Google);

      await createEvent(alice.id, engineering);
      await queue.drain();
      await syncTarget(off.configId);
      await syncTarget(outsider.configId);

      expect(await off.calls()).toEqual([]);
      expect(await outsider.calls()).toEqual([]);
    });
  });
});
