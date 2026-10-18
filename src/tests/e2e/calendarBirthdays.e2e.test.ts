import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { and, asc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser, resetReportData } from "./helpers/reportFixtures.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { saveBirthday } from "../../services/birthday/birthdayServices.js";
import { userBirthdays } from "../../db/schema/user-birthday-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { calendarSync, calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import {
  calendarConnection,
  calendarProvider,
  calendarSyncEventKind,
  calendarSyncEvents,
  calendarSyncFakeEvents,
} from "../../db/schema/calendar-connection-schema.js";
import { encryptOAuthToken } from "../../utils/oauthTokens.js";
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

describe("birthdays in feeds and direct sync", () => {
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

  const createFeed = async (ownerId: string, body: Record<string, unknown>) =>
    request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", await authCookieFor(ownerId))
      .send(body);

  const feedOf = async (ownerId: string, body: Record<string, unknown>) => {
    const created = await createFeed(ownerId, body);
    expect(created.status).toBe(201);
    const token = (created.body.feedUrl as string).match(/(flx_live_[a-f0-9]{40})\.ics$/)![1]!;
    return async () => {
      const response = await request(server.url).get(`/calendars/${token}.ics`).expect(200);
      return vevents(response.text || String(response.body));
    };
  };

  const setCreatedAt = (userId: string, createdAt: Date) =>
    db.update(userBirthdays).set({ createdAt }).where(eq(userBirthdays.userId, userId));

  /**
   * Two paid groups the owner sees in full. Alice shares and sits in both;
   * Bob is in the first and does not share; Carol shares from the second.
   */
  const seedTeams = async () => {
    const manager = await makeUser("Manager");
    const owner = await makeUser("Olivia Owner");
    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const carol = await makeUser("Carol");
    const first = await makeGroup("Engineering", manager.id);
    const second = await makeGroup("Design", manager.id);
    await makePaid(manager.id);
    for (const groupId of [first, second]) {
      await addMember(groupId, owner.id, { viewAccess: true });
      await addMember(groupId, alice.id);
    }
    await addMember(first, bob.id);
    await addMember(second, carol.id);
    await saveBirthday(owner.id, { month: 10, day: 25, year: 1987, shared: false });
    await saveBirthday(alice.id, { month: 3, day: 14, year: 1990, shared: true });
    await saveBirthday(bob.id, { month: 4, day: 2, year: 1985, shared: false });
    await saveBirthday(carol.id, { month: 6, day: 30, year: null, shared: true });
    return { manager, owner, alice, bob, carol, first, second };
  };

  describe("a personal feed", () => {
    it("carries only the owner's birthday, titled Birthday, free, anchored and without an age", async () => {
      const { owner } = await seedTeams();
      await saveBirthday(owner.id, { month: 2, day: 29, year: 1992, shared: true });
      await setCreatedAt(owner.id, new Date("2025-03-01T10:00:00Z"));

      const fetch = await feedOf(owner.id, {
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [],
        includeBirthdays: true,
      });
      const events = await fetch();

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(line(event!, "UID")).toBe(`UID:bd-${owner.id}@flexiday`);
      expect(line(event!, "DTSTART")).toBe("DTSTART;VALUE=DATE:20260228");
      expect(line(event!, "DTEND")).toBe("DTEND;VALUE=DATE:20260301");
      expect(line(event!, "RRULE")).toBe("RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1");
      expect(line(event!, "SUMMARY")).toBe("SUMMARY:Birthday");
      expect(line(event!, "TRANSP")).toBe("TRANSP:TRANSPARENT");
      expect(event!.join("\n")).not.toMatch(/1992|turns|\b34\b/);
    });

    it("keeps the series start when the birthday is saved again", async () => {
      const { owner } = await seedTeams();
      await setCreatedAt(owner.id, new Date("2024-11-02T08:00:00Z"));
      const fetch = await feedOf(owner.id, {
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [],
        includeBirthdays: true,
      });
      expect(line((await fetch())[0]!, "DTSTART")).toBe("DTSTART;VALUE=DATE:20251025");

      await saveBirthday(owner.id, { month: 10, day: 25, year: null, shared: true });

      const [event] = await fetch();
      expect(line(event!, "DTSTART")).toBe("DTSTART;VALUE=DATE:20251025");
      expect(line(event!, "RRULE")).toBe("RRULE:FREQ=YEARLY");
    });

    it("titles the birthday in the owner's language", async () => {
      const { owner } = await seedTeams();
      const fetch = await feedOf(owner.id, {
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [{ type: "VACATION", color: "blue" }],
        includeBirthdays: true,
      });
      await request(server.url)
        .put("/api/users/me/settings")
        .set("Cookie", await authCookieFor(owner.id))
        .send({ language: "cs" })
        .expect(200);

      expect(line((await fetch())[0]!, "SUMMARY")).toBe("SUMMARY:Narozeniny");
    });

    it("carries no birthday while the Birthdays row is off", async () => {
      const { owner } = await seedTeams();
      const fetch = await feedOf(owner.id, {
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [{ type: "VACATION", color: "blue" }],
      });

      expect(await fetch()).toEqual([]);
    });
  });

  describe("a team feed", () => {
    const teamFeed = (ownerId: string, teamIds: string[]) =>
      feedOf(ownerId, { name: "Team", scope: "TEAM", teamIds, types: [], includeBirthdays: true });

    it("carries each member's shared birthday once across two groups, titled with the name", async () => {
      const { owner, alice, carol, first, second } = await seedTeams();

      const events = await (await teamFeed(owner.id, [first, second]))();

      const byUid = new Map(events.map((event) => [line(event, "UID"), event]));
      expect([...byUid.keys()].sort()).toEqual(
        [`UID:bd-${alice.id}@flexiday`, `UID:bd-${carol.id}@flexiday`].sort()
      );
      expect(line(byUid.get(`UID:bd-${alice.id}@flexiday`)!, "SUMMARY")).toBe(
        "SUMMARY:Alice — Birthday"
      );
      expect(line(byUid.get(`UID:bd-${carol.id}@flexiday`)!, "SUMMARY")).toBe(
        "SUMMARY:Carol — Birthday"
      );
      for (const event of events) {
        expect(line(event, "TRANSP")).toBe("TRANSP:TRANSPARENT");
        expect(event.join("\n")).not.toMatch(/1990|turns/);
      }
    });

    it("titles birthdays in the owner's language", async () => {
      const { owner, first } = await seedTeams();
      const fetch = await teamFeed(owner.id, [first]);
      await request(server.url)
        .put("/api/users/me/settings")
        .set("Cookie", await authCookieFor(owner.id))
        .send({ language: "cs" })
        .expect(200);

      expect((await fetch()).map((event) => line(event, "SUMMARY"))).toEqual([
        "SUMMARY:Alice — Narozeniny",
      ]);
    });

    it("drops a group's birthdays once the owner leaves it", async () => {
      const { owner, alice, first, second } = await seedTeams();
      const fetch = await teamFeed(owner.id, [first, second]);
      await db
        .update(groupUsers)
        .set({ deletedAt: new Date() })
        .where(and(eq(groupUsers.groupId, second), eq(groupUsers.userId, owner.id)));

      expect((await fetch()).map((event) => line(event, "UID"))).toEqual([
        `UID:bd-${alice.id}@flexiday`,
      ]);
    });

    it("carries no birthday from a group whose organization never paid", async () => {
      const manager = await makeUser("Free manager");
      const owner = await makeUser("Olivia Owner");
      const colleague = await makeUser("Petra");
      const groupId = await makeGroup("Free team", manager.id);
      await addMember(groupId, owner.id, { viewAccess: true });
      await addMember(groupId, colleague.id);
      await saveBirthday(colleague.id, { month: 5, day: 5, year: null, shared: true });

      expect(await (await teamFeed(owner.id, [groupId]))()).toEqual([]);
    });
  });

  it("refuses a feed that carries nothing", async () => {
    const owner = await makeUser("Olivia Owner");

    const response = await createFeed(owner.id, {
      name: "Empty",
      scope: "ME",
      teamIds: [],
      types: [],
    });

    expect(response.status).toBe(422);
  });

  describe("direct sync on the fake driver", () => {
    let connectionId: string;
    let configId: string;
    let queue: ReturnType<typeof createSyncQueue>;

    const connect = async (ownerId: string, provider: calendarProvider) => {
      const slug = provider.toLowerCase();
      connectionId = uuidv4();
      await db.insert(calendarConnection).values({
        id: connectionId,
        userId: ownerId,
        provider,
        refreshTokenEnc: await encryptOAuthToken(`fake-refresh-${slug}-fake-code`),
        accessTokenEnc: await encryptOAuthToken(`fake-access-${slug}-fake-code`),
        accessTokenExpiresAt: new Date(Date.now() + HOUR_MS),
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
        includeBirthdays: true,
      });
    };

    const calls = () =>
      db
        .select()
        .from(calendarSyncFakeEvents)
        .where(eq(calendarSyncFakeEvents.connectionId, connectionId))
        .orderBy(asc(calendarSyncFakeEvents.createdAt));

    const ledger = () =>
      db.select().from(calendarSyncEvents).where(eq(calendarSyncEvents.calendarSyncId, configId));

    const putBirthday = async (userId: string, body: Record<string, unknown>) =>
      request(server.url)
        .put("/api/users/me/birthday")
        .set("Cookie", await authCookieFor(userId))
        .send(body)
        .expect(200);

    beforeEach(() => {
      // Uninstalling stops a queue for good, so each case gets its own.
      queue = createSyncQueue({ run: (id) => syncTarget(id) });
      installCalendarSyncQueue(queue);
    });

    afterEach(() => {
      installCalendarSyncQueue(undefined);
    });

    it("inserts one series when the owner saves a birthday and deletes it on removal", async () => {
      const owner = await makeUser("Olivia Owner");
      await connect(owner.id, calendarProvider.Google);

      await putBirthday(owner.id, { month: 10, day: 25, year: 1987, shared: false });
      await queue.drain();

      const [inserted] = await calls();
      expect((await calls()).map((call) => call.operation)).toEqual(["INSERT"]);
      expect(inserted?.payload).toMatchObject({
        eventType: "default",
        summary: "Birthday",
        transparency: "transparent",
        recurrence: ["RRULE:FREQ=YEARLY"],
        extendedProperties: { private: { flexiDaySourceKey: `bd:${owner.id}` } },
      });
      expect(JSON.stringify(inserted?.payload)).not.toContain("1987");
      expect(await ledger()).toEqual([
        expect.objectContaining({
          sourceKey: `bd:${owner.id}`,
          birthdayUserId: owner.id,
          vacationId: null,
          kind: calendarSyncEventKind.Birthday,
        }),
      ]);

      await request(server.url)
        .delete("/api/users/me/birthday")
        .set("Cookie", await authCookieFor(owner.id))
        .expect(204);
      await queue.drain();

      expect((await calls()).map((call) => [call.operation, call.providerEventId])).toEqual([
        ["INSERT", expect.any(String)],
        ["DELETE", (await calls())[0]?.providerEventId],
      ]);
      expect(await ledger()).toEqual([]);
    });

    it("patches the series when the date changes and leaves it alone on a rerun", async () => {
      const owner = await makeUser("Olivia Owner");
      await connect(owner.id, calendarProvider.Microsoft);
      await putBirthday(owner.id, { month: 10, day: 25, year: null, shared: false });
      await queue.drain();

      await putBirthday(owner.id, { month: 10, day: 26, year: null, shared: false });
      await queue.drain();
      await syncTarget(configId);

      expect((await calls()).map((call) => call.operation)).toEqual(["INSERT", "PATCH"]);
    });

    it("sends a 29 February birthday to Microsoft as one absoluteYearly series", async () => {
      const owner = await makeUser("Olivia Owner");
      await connect(owner.id, calendarProvider.Microsoft);

      await putBirthday(owner.id, { month: 2, day: 29, year: 1992, shared: false });
      await queue.drain();

      const sent = await calls();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.payload).toMatchObject({
        subject: "Birthday",
        isAllDay: true,
        showAs: "free",
        recurrence: {
          pattern: { type: "absoluteYearly", interval: 1, month: 2, dayOfMonth: 29 },
          range: { type: "noEnd" },
        },
      });
      expect((await ledger()).map((row) => row.sourceKey)).toEqual([`bd:${owner.id}`]);
    });

    it("never writes a colleague's shared birthday to anyone's target", async () => {
      const { owner, alice } = await seedTeams();
      await connect(owner.id, calendarProvider.Google);
      await syncTarget(configId);
      expect((await calls()).map((call) => call.operation)).toEqual(["INSERT"]);

      await putBirthday(alice.id, { month: 3, day: 15, year: 1990, shared: true });
      await queue.drain();
      await syncTarget(configId);

      expect(await calls()).toHaveLength(1);
      expect((await ledger()).map((row) => row.sourceKey)).toEqual([`bd:${owner.id}`]);
    });
  });
});
