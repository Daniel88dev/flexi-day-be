import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groupEvents, groupEventRepeatFreq } from "../../db/schema/group-event-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { authCookieFor } from "./helpers/authHelper.js";

type Caller = "orgOwner" | "manager" | "viewer" | "member" | "outsider";

const DAY_MS = 24 * 60 * 60 * 1000;

type EventRow = {
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  repeat: unknown;
  skippedDates: string[];
  createdBy: { id: string; name: string } | null;
  canEdit: boolean;
};

describe("group events", () => {
  let server: LoopbackServer;
  const ids = {} as Record<Caller, string>;
  const cookies = {} as Record<Caller, string>;
  let proGroup: string;
  let freeGroup: string;
  let lapsedGroup: string;

  const as = (caller: Caller) => ({
    get: (path: string) => request(server.url).get(path).set("Cookie", cookies[caller]),
    post: (path: string) => request(server.url).post(path).set("Cookie", cookies[caller]),
  });

  const create = (caller: Caller, body: Record<string, unknown>) =>
    as(caller)
      .post("/api/group-events")
      .send({ groupId: proGroup, title: "Retro", startDate: "2026-11-10", ...body });

  const listNovember = async (caller: Caller, groupId?: string) => {
    const res = await as(caller)
      .get("/api/group-events")
      .query({ year: 2026, month: 11, ...(groupId ? { groupId } : {}) })
      .expect(200);
    return res.body as EventRow[];
  };

  const seedEvent = async (
    groupId: string,
    values: Partial<typeof groupEvents.$inferInsert> = {}
  ): Promise<string> => {
    const id = uuidv4();
    await db.insert(groupEvents).values({
      id,
      groupId,
      createdByUserId: ids.member,
      title: "Seeded",
      startDate: "2026-11-12",
      endDate: "2026-11-12",
      ...values,
    });
    return id;
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    ids.orgOwner = (await makeUser("Olga Owner")).id;
    ids.manager = (await makeUser("Mark Manager")).id;
    ids.viewer = (await makeUser("Vera Viewer")).id;
    ids.member = (await makeUser("Milo Member")).id;
    ids.outsider = (await makeUser("Otto Outsider")).id;
    const freeOwner = (await makeUser("Fred Free")).id;
    const lapsedOwner = (await makeUser("Lena Lapsed")).id;

    proGroup = await makeGroup("Pro Team", ids.manager, { organizationOwnerId: ids.orgOwner });
    freeGroup = await makeGroup("Free Team", freeOwner);
    lapsedGroup = await makeGroup("Lapsed Team", lapsedOwner);

    const proOrganization = await ensureOrganizationForUser(ids.orgOwner);
    await upsertSubscription(proOrganization.id, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    const lapsedOrganization = await ensureOrganizationForUser(lapsedOwner);
    await upsertSubscription(lapsedOrganization.id, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Canceled,
      graceEndsAt: new Date(Date.now() - DAY_MS),
    });

    await addMember(proGroup, ids.manager, { viewAccess: true, adminAccess: true });
    for (const groupId of [proGroup, freeGroup, lapsedGroup]) {
      await addMember(groupId, ids.viewer, { viewAccess: true });
      await addMember(groupId, ids.member);
    }

    for (const caller of Object.keys(ids) as Caller[]) {
      cookies[caller] = await authCookieFor(ids[caller]);
    }
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  describe("POST /api/group-events", () => {
    it("lets a view-only member create, and answers the row with its group and creator", async () => {
      const res = await create("viewer", {
        title: "  Team lunch  ",
        startTime: "12:00",
        endTime: "13:00",
      }).expect(201);

      expect(res.body).toMatchObject({
        groupId: proGroup,
        groupName: "Pro Team",
        title: "Team lunch",
        note: null,
        startDate: "2026-11-10",
        endDate: "2026-11-10",
        startTime: "12:00",
        endTime: "13:00",
        repeat: null,
        skippedDates: [],
        recurringEventId: null,
        originalDate: null,
        createdBy: { id: ids.viewer, name: "Vera Viewer" },
        canEdit: true,
      });
    });

    it("lets a member with no flags create a recurring group event", async () => {
      // 10 Nov 2026 is a Tuesday (1).
      const res = await create("member", {
        repeat: { freq: "weekly", interval: 2, weekdays: [3, 1], until: "2027-03-30" },
      }).expect(201);

      expect(res.body.repeat).toEqual({
        freq: "weekly",
        interval: 2,
        weekdays: [1, 3],
        monthlyMode: null,
        until: "2027-03-30",
      });
    });

    it("lets an org admin who is not a member create", async () => {
      const res = await create("orgOwner", { title: "All hands" }).expect(201);
      expect(res.body.createdBy.id).toBe(ids.orgOwner);
    });

    it("refuses a caller with no membership and no admin right", async () => {
      await create("outsider", {}).expect(403);
    });

    it("answers 402 with GROUP_EVENTS_PLAN_REQUIRED for a group that never paid", async () => {
      const res = await create("viewer", { groupId: freeGroup }).expect(402);
      expect(res.body.errors[0].context).toEqual({
        reason: "PLAN_LIMIT",
        code: "GROUP_EVENTS_PLAN_REQUIRED",
      });
    });

    it("answers 402 for a lapsed group", async () => {
      const res = await create("viewer", { groupId: lapsedGroup }).expect(402);
      expect(res.body.errors[0].context.code).toBe("GROUP_EVENTS_PLAN_REQUIRED");
    });

    it("answers 404 for a group that does not exist", async () => {
      await create("viewer", { groupId: uuidv4() }).expect(404);
    });

    it("refuses a repeat rule on a multi-day event", async () => {
      await create("viewer", {
        endDate: "2026-11-11",
        repeat: { freq: "daily", interval: 1 },
      }).expect(422);
    });

    it("refuses a single-day end before its start", async () => {
      await create("viewer", { startTime: "14:00", endTime: "13:00" }).expect(422);
    });

    it("refuses a weekly rule without the start's weekday", async () => {
      await create("viewer", { repeat: { freq: "weekly", interval: 1, weekdays: [4] } }).expect(
        422
      );
    });
  });

  describe("GET /api/group-events", () => {
    let inWindow: string;
    let paddedBefore: string;
    let outside: string;
    let recurringFromOctober: string;
    let endedBefore: string;
    let lapsedEvent: string;
    let freeEvent: string;
    let deleted: string;

    beforeAll(async () => {
      await db.delete(groupEvents);
      inWindow = await seedEvent(proGroup, { title: "Offsite", endDate: "2026-11-14" });
      // November 2026's grid starts on Monday 26 October.
      paddedBefore = await seedEvent(proGroup, {
        startDate: "2026-10-27",
        endDate: "2026-10-27",
      });
      outside = await seedEvent(proGroup, { startDate: "2026-10-01", endDate: "2026-10-01" });
      recurringFromOctober = await seedEvent(proGroup, {
        createdByUserId: ids.viewer,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        startTime: "09:00",
        endTime: "09:15",
        repeatFreq: groupEventRepeatFreq.Weekly,
        repeatInterval: 1,
        repeatWeekdays: [0],
        skippedDates: ["2026-11-09"],
      });
      endedBefore = await seedEvent(proGroup, {
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        repeatFreq: groupEventRepeatFreq.Daily,
        repeatInterval: 1,
        repeatUntil: "2026-10-20",
      });
      lapsedEvent = await seedEvent(lapsedGroup);
      freeEvent = await seedEvent(freeGroup);
      deleted = await seedEvent(proGroup, { title: null, deletedAt: new Date() });
    });

    it("lists every group the caller is a member of, padded six days each side", async () => {
      const rows = await listNovember("viewer");
      const listed = rows.map((row) => row.id);

      expect(listed).toEqual(
        expect.arrayContaining([
          inWindow,
          paddedBefore,
          recurringFromOctober,
          lapsedEvent,
          freeEvent,
        ])
      );
      expect(listed).not.toContain(outside);
      expect(listed).not.toContain(endedBefore);
      expect(listed).not.toContain(deleted);
    });

    it("carries the rule and skipped dates for the client to expand", async () => {
      const rows = await listNovember("viewer", proGroup);
      const recurring = rows.find((row) => row.id === recurringFromOctober)!;

      expect(recurring).toMatchObject({
        startDate: "2026-10-05",
        startTime: "09:00",
        endTime: "09:15",
        repeat: { freq: "weekly", interval: 1, weekdays: [0], monthlyMode: null, until: null },
        skippedDates: ["2026-11-09"],
        createdBy: { id: ids.viewer },
      });
    });

    it("still lists a lapsed group's events", async () => {
      const rows = await listNovember("member", lapsedGroup);
      expect(rows.map((row) => row.id)).toEqual([lapsedEvent]);
    });

    it("gives canEdit to the creator while a member and to group admins, nobody else", async () => {
      const editable = async (caller: Caller) =>
        Object.fromEntries(
          (await listNovember(caller, proGroup)).map((row) => [row.id, row.canEdit])
        );

      expect((await editable("member"))[inWindow]).toBe(true);
      expect((await editable("member"))[recurringFromOctober]).toBe(false);
      expect((await editable("viewer"))[recurringFromOctober]).toBe(true);
      expect((await editable("viewer"))[inWindow]).toBe(false);
      expect(Object.values(await editable("manager")).every(Boolean)).toBe(true);
      expect(Object.values(await editable("orgOwner")).every(Boolean)).toBe(true);
    });

    it("lets an org admin who is not a member read the group", async () => {
      const rows = await listNovember("orgOwner", proGroup);
      expect(rows.map((row) => row.id)).toContain(inWindow);
    });

    it("refuses a group the caller neither belongs to nor administers", async () => {
      await as("outsider")
        .get("/api/group-events")
        .query({ year: 2026, month: 11, groupId: proGroup })
        .expect(403);
    });

    it("answers nothing for a caller without groups", async () => {
      expect(await listNovember("outsider")).toEqual([]);
    });

    it("refuses a month out of range", async () => {
      await as("viewer").get("/api/group-events").query({ year: 2026, month: 13 }).expect(422);
    });
  });

  describe("GET /api/group-events/groups", () => {
    const groupsOf = async (caller: Caller) => {
      const res = await as(caller).get("/api/group-events/groups").expect(200);
      return res.body as { groupId: string; groupName: string; canCreate: boolean }[];
    };

    it("reports canCreate per group: paid yes, never paid and lapsed no", async () => {
      expect(await groupsOf("viewer")).toEqual([
        { groupId: freeGroup, groupName: "Free Team", canCreate: false },
        { groupId: lapsedGroup, groupName: "Lapsed Team", canCreate: false },
        { groupId: proGroup, groupName: "Pro Team", canCreate: true },
      ]);
    });

    it("counts a member with no flags like a view-only one", async () => {
      expect(await groupsOf("member")).toEqual(await groupsOf("viewer"));
    });

    it("lists a group the caller administers without belonging to it", async () => {
      expect(await groupsOf("orgOwner")).toEqual([
        { groupId: proGroup, groupName: "Pro Team", canCreate: true },
      ]);
    });

    it("answers nothing for a caller with no group", async () => {
      expect(await groupsOf("outsider")).toEqual([]);
    });
  });
});
