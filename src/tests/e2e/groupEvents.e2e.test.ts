import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/db.js";
import { groupEvents, groupEventRepeatFreq } from "../../db/schema/group-event-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { addMember, makeGroup, makeUser, removeMember } from "./helpers/reportFixtures.js";
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
    patch: (path: string) => request(server.url).patch(path).set("Cookie", cookies[caller]),
    delete: (path: string) => request(server.url).delete(path).set("Cookie", cookies[caller]),
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

  const loadEvent = async (id: string) => {
    const [row] = await db.select().from(groupEvents).where(eq(groupEvents.id, id));
    return row!;
  };

  const linkedTo = (id: string) =>
    db
      .select()
      .from(groupEvents)
      .where(and(eq(groupEvents.recurringEventId, id), isNull(groupEvents.deletedAt)));

  // Tuesday 3 November 2026, weekly on Tuesdays, 09:00 to 09:30, by the member.
  const seedWeekly = (groupId = proGroup, values: Partial<typeof groupEvents.$inferInsert> = {}) =>
    seedEvent(groupId, {
      title: "Standup",
      startDate: "2026-11-03",
      endDate: "2026-11-03",
      startTime: "09:00",
      endTime: "09:30",
      repeatFreq: groupEventRepeatFreq.Weekly,
      repeatInterval: 1,
      repeatWeekdays: [1],
      ...values,
    });

  const edit = (caller: Caller, id: string, body: Record<string, unknown>) =>
    as(caller).patch(`/api/group-events/${id}`).send(body);

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

  describe("PATCH /api/group-events/:id", () => {
    it("edits one occurrence as a skipped date plus a linked one-off, leaving the rule", async () => {
      const id = await seedWeekly();
      const res = await edit("member", id, {
        scope: "this",
        occurrenceDate: "2026-11-17",
        changes: {
          title: "Standup at the office",
          startDate: "2026-11-18",
          startTime: "10:00",
          endTime: "10:30",
        },
      }).expect(200);

      expect(res.body.droppedOneOffs).toBe(0);
      const recurring = await loadEvent(id);
      expect(recurring).toMatchObject({
        title: "Standup",
        startDate: "2026-11-03",
        repeatFreq: "WEEKLY",
        repeatWeekdays: [1],
        repeatUntil: null,
        skippedDates: ["2026-11-17"],
      });
      const [oneOff, ...rest] = await linkedTo(id);
      expect(rest).toEqual([]);
      expect(oneOff).toMatchObject({
        title: "Standup at the office",
        startDate: "2026-11-18",
        endDate: "2026-11-18",
        startTime: "10:00:00",
        endTime: "10:30:00",
        repeatFreq: null,
        recurringEventId: id,
        originalDate: "2026-11-17",
        createdByUserId: ids.member,
      });
      expect(res.body.events.map((row: EventRow) => row.id).sort()).toEqual(
        [id, oneOff!.id].sort()
      );
      expect(res.body.deletedIds).toEqual([]);
    });

    const editOccurrence = async (id: string, occurrenceDate: string, title: string) => {
      const res = await edit("member", id, {
        scope: "this",
        occurrenceDate,
        changes: { title },
      }).expect(200);
      return (res.body.events as EventRow[]).find((row) => row.id !== id)!.id;
    };

    const skipOccurrence = (id: string, occurrenceDate: string) =>
      as("member")
        .delete(`/api/group-events/${id}`)
        .query({ scope: "this", occurrenceDate })
        .expect(200);

    const impact = async (id: string, query: Record<string, unknown>) => {
      const res = await as("member")
        .get(`/api/group-events/${id}/impact`)
        .query({
          ...query,
          ...(query.changes ? { changes: JSON.stringify(query.changes) } : {}),
        })
        .expect(200);
      return res.body.droppedOneOffs as number;
    };

    it("splits at the date with this and following, moving later one-offs to the new event", async () => {
      const id = await seedWeekly(proGroup, { repeatUntil: "2027-03-30" });
      const before = await editOccurrence(id, "2026-11-10", "Early");
      const after = await editOccurrence(id, "2026-11-24", "Late");
      await skipOccurrence(id, "2026-12-01");

      const res = await edit("member", id, {
        scope: "following",
        occurrenceDate: "2026-11-17",
        changes: { note: "In room 4" },
      }).expect(200);
      expect(res.body.droppedOneOffs).toBe(0);

      expect(await loadEvent(id)).toMatchObject({
        note: null,
        startDate: "2026-11-03",
        repeatUntil: "2026-11-16",
        skippedDates: ["2026-11-10"],
      });
      const split = (res.body.events as EventRow[]).find(
        (row) => ![id, before, after].includes(row.id)
      )!;
      expect(await loadEvent(split.id)).toMatchObject({
        title: "Standup",
        note: "In room 4",
        startDate: "2026-11-17",
        endDate: "2026-11-17",
        startTime: "09:00:00",
        repeatFreq: "WEEKLY",
        repeatWeekdays: [1],
        repeatUntil: "2027-03-30",
        skippedDates: ["2026-11-24", "2026-12-01"],
        createdByUserId: ids.member,
        recurringEventId: null,
      });
      expect(await loadEvent(before)).toMatchObject({ title: "Early", recurringEventId: id });
      expect(await loadEvent(after)).toMatchObject({
        title: "Late",
        note: "In room 4",
        recurringEventId: split.id,
        originalDate: "2026-11-24",
      });
    });

    it("overwrites one-offs through all events when the title changes, keeping deleted dates", async () => {
      const id = await seedWeekly();
      const oneOff = await editOccurrence(id, "2026-11-10", "Moved standup");
      await skipOccurrence(id, "2026-11-17");

      const res = await edit("member", id, {
        scope: "all",
        changes: { title: "Daily sync" },
      }).expect(200);

      expect(res.body.droppedOneOffs).toBe(0);
      expect(await loadEvent(id)).toMatchObject({
        title: "Daily sync",
        skippedDates: ["2026-11-10", "2026-11-17"],
      });
      expect(await loadEvent(oneOff)).toMatchObject({
        title: "Daily sync",
        recurringEventId: id,
        deletedAt: null,
      });
    });

    it("drops every one-off change when all events changes the rule, after impact counts them", async () => {
      const id = await seedWeekly();
      const oneOff = await editOccurrence(id, "2026-11-10", "Moved standup");
      await skipOccurrence(id, "2026-11-17");
      const changes = { repeat: { freq: "weekly", interval: 2, weekdays: [1] } };

      expect(await impact(id, { scope: "all", changes })).toBe(2);
      expect(await impact(id, { scope: "all", changes: { title: "Renamed" } })).toBe(0);
      expect(await loadEvent(id)).toMatchObject({ repeatInterval: 1 });

      const res = await edit("member", id, { scope: "all", changes }).expect(200);

      expect(res.body.droppedOneOffs).toBe(2);
      expect(res.body.deletedIds).toEqual([oneOff]);
      expect(await loadEvent(id)).toMatchObject({ repeatInterval: 2, skippedDates: [] });
      expect(await loadEvent(oneOff)).toMatchObject({ title: null, deletedAt: expect.any(Date) });
    });

    it("drops one-off changes when all events moves the start", async () => {
      const id = await seedWeekly();
      await editOccurrence(id, "2026-11-10", "Moved standup");

      expect(await impact(id, { scope: "all", changes: { startDate: "2026-11-10" } })).toBe(1);
      const res = await edit("member", id, {
        scope: "all",
        changes: { startDate: "2026-11-10" },
      }).expect(200);
      expect(res.body.droppedOneOffs).toBe(1);
      expect(await linkedTo(id)).toEqual([]);
    });

    it("keeps one-off changes up to a new end date when all events changes only until", async () => {
      const id = await seedWeekly();
      const kept = await editOccurrence(id, "2026-11-10", "Kept");
      const gone = await editOccurrence(id, "2026-12-08", "Gone");
      await skipOccurrence(id, "2026-12-15");
      const changes = {
        repeat: { freq: "weekly", interval: 1, weekdays: [1], until: "2026-12-01" },
      };

      expect(await impact(id, { scope: "all", changes })).toBe(2);
      const res = await edit("member", id, { scope: "all", changes }).expect(200);

      expect(res.body.deletedIds).toEqual([gone]);
      expect(await loadEvent(id)).toMatchObject({
        repeatUntil: "2026-12-01",
        skippedDates: ["2026-11-10"],
      });
      expect(await loadEvent(kept)).toMatchObject({ title: "Kept", deletedAt: null });
    });

    it("keeps only the first occurrence when all events turns repeat off", async () => {
      const id = await seedWeekly();
      const oneOff = await editOccurrence(id, "2026-11-17", "Moved standup");

      const res = await edit("member", id, { scope: "all", changes: { repeat: null } }).expect(200);

      expect(res.body.droppedOneOffs).toBe(1);
      expect(await loadEvent(id)).toMatchObject({
        title: "Standup",
        startDate: "2026-11-03",
        endDate: "2026-11-03",
        repeatFreq: null,
        repeatInterval: null,
        repeatWeekdays: null,
        skippedDates: [],
      });
      expect((await loadEvent(oneOff)).deletedAt).not.toBeNull();
    });

    it("keeps the earlier occurrences plus this one as a one-off when following turns repeat off", async () => {
      const id = await seedWeekly();
      const earlier = await editOccurrence(id, "2026-11-10", "Earlier");
      const later = await editOccurrence(id, "2026-11-24", "Later");

      const res = await edit("member", id, {
        scope: "following",
        occurrenceDate: "2026-11-17",
        changes: { repeat: null, title: "Last standup" },
      }).expect(200);

      expect(res.body.droppedOneOffs).toBe(1);
      expect(res.body.deletedIds).toEqual([later]);
      expect(await loadEvent(id)).toMatchObject({
        repeatUntil: "2026-11-16",
        skippedDates: ["2026-11-10"],
      });
      expect(await loadEvent(earlier)).toMatchObject({ title: "Earlier", deletedAt: null });
      const last = (res.body.events as EventRow[]).find((row) => row.id !== id)!;
      expect(last).toMatchObject({
        title: "Last standup",
        startDate: "2026-11-17",
        endDate: "2026-11-17",
        repeat: null,
        recurringEventId: null,
      });
    });

    it("treats this and following from the first occurrence as all events", async () => {
      const id = await seedWeekly();
      const res = await edit("member", id, {
        scope: "following",
        occurrenceDate: "2026-11-03",
        changes: { title: "Renamed" },
      }).expect(200);

      expect(res.body.events.map((row: EventRow) => row.id)).toEqual([id]);
      expect(await loadEvent(id)).toMatchObject({ title: "Renamed", repeatUntil: null });
    });

    it("turns repeat on for a one-off", async () => {
      const id = await seedEvent(proGroup, { startDate: "2026-11-11", endDate: "2026-11-11" });
      const res = await edit("member", id, {
        changes: { repeat: { freq: "monthly", interval: 1, monthlyMode: "day" } },
      }).expect(200);

      expect(res.body.events[0].repeat).toEqual({
        freq: "monthly",
        interval: 1,
        weekdays: [],
        monthlyMode: "day",
        until: null,
      });
    });

    it("edits past occurrences like any other", async () => {
      const id = await seedWeekly(proGroup, { startDate: "2024-01-02", endDate: "2024-01-02" });
      await edit("member", id, {
        scope: "this",
        occurrenceDate: "2024-01-09",
        changes: { title: "Long ago" },
      }).expect(200);
    });

    it("refuses a new rule for one occurrence", async () => {
      const id = await seedWeekly();
      await edit("member", id, {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: { repeat: { freq: "daily", interval: 1 } },
      }).expect(422);
    });

    it("refuses an occurrence date the rule does not produce or already skipped", async () => {
      const id = await seedWeekly(proGroup, { skippedDates: ["2026-11-10"] });
      for (const occurrenceDate of ["2026-11-11", "2026-11-10", "2026-10-27"]) {
        await edit("member", id, {
          scope: "this",
          occurrenceDate,
          changes: { title: "Nope" },
        }).expect(422);
      }
    });

    it("refuses a recurring group event edit without a scope or a this edit without a date", async () => {
      const id = await seedWeekly();
      await edit("member", id, { changes: { title: "Nope" } }).expect(422);
      await edit("member", id, { scope: "this", changes: { title: "Nope" } }).expect(422);
    });

    it("refuses an edit that breaks the event's shape", async () => {
      const id = await seedWeekly();
      await edit("member", id, { scope: "all", changes: { startDate: "2026-11-04" } }).expect(422);
      await edit("member", id, {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: { endDate: "2026-11-11" },
      }).expect(422);
    });

    it("answers 404 for a deleted or unknown group event", async () => {
      const id = await seedEvent(proGroup, { title: null, deletedAt: new Date() });
      await edit("member", id, { changes: { title: "Back" } }).expect(404);
      await edit("member", uuidv4(), { changes: { title: "Back" } }).expect(404);
    });
  });

  describe("who may edit and delete", () => {
    it("refuses a member who is not the creator", async () => {
      const id = await seedWeekly();
      await edit("viewer", id, { scope: "all", changes: { title: "Mine now" } }).expect(403);
      await as("viewer").get(`/api/group-events/${id}/impact`).query({ scope: "all" }).expect(403);
      await as("viewer").delete(`/api/group-events/${id}`).query({ scope: "all" }).expect(403);
      expect(await loadEvent(id)).toMatchObject({ title: "Standup", deletedAt: null });
    });

    it("lets a group admin and an org admin who is not a member edit and delete", async () => {
      const id = await seedWeekly();
      await edit("manager", id, { scope: "all", changes: { title: "By the manager" } }).expect(200);
      await edit("orgOwner", id, {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: { title: "By the org admin" },
      }).expect(200);
      await as("orgOwner").delete(`/api/group-events/${id}`).query({ scope: "all" }).expect(200);
    });

    it("refuses a creator who left the group", async () => {
      const leaver = (await makeUser("Lou Leaver")).id;
      await addMember(proGroup, leaver);
      const cookie = await authCookieFor(leaver);
      const id = await seedWeekly(proGroup, { createdByUserId: leaver });
      await request(server.url)
        .patch(`/api/group-events/${id}`)
        .set("Cookie", cookie)
        .send({ scope: "all", changes: { title: "Still mine" } })
        .expect(200);

      await removeMember(proGroup, leaver);

      await request(server.url)
        .patch(`/api/group-events/${id}`)
        .set("Cookie", cookie)
        .send({ scope: "all", changes: { title: "Still mine?" } })
        .expect(403);
      await request(server.url)
        .delete(`/api/group-events/${id}`)
        .set("Cookie", cookie)
        .query({ scope: "all" })
        .expect(403);
    });
  });

  describe("on a lapsed group", () => {
    it("still edits and deletes", async () => {
      const id = await seedWeekly(lapsedGroup);
      await edit("member", id, {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: { title: "Moved" },
      }).expect(200);
      await edit("member", id, { scope: "all", changes: { title: "Renamed" } }).expect(200);
      await edit("member", id, {
        scope: "following",
        occurrenceDate: "2026-11-03",
        changes: { note: "From the start" },
      }).expect(200);
      await as("member")
        .delete(`/api/group-events/${id}`)
        .query({ scope: "this", occurrenceDate: "2026-11-17" })
        .expect(200);
      await as("member")
        .delete(`/api/group-events/${id}`)
        .query({ scope: "following", occurrenceDate: "2026-12-01" })
        .expect(200);
      await as("member").delete(`/api/group-events/${id}`).query({ scope: "all" }).expect(200);
    });

    it("answers 402 to a this and following split, writing nothing", async () => {
      const id = await seedWeekly(lapsedGroup);
      const res = await edit("member", id, {
        scope: "following",
        occurrenceDate: "2026-11-17",
        changes: { title: "Split" },
      }).expect(402);

      expect(res.body.errors[0].context).toEqual({
        reason: "PLAN_LIMIT",
        code: "GROUP_EVENTS_PLAN_REQUIRED",
      });
      expect(await loadEvent(id)).toMatchObject({ title: "Standup", repeatUntil: null });
    });

    it("answers 402 when a one-off gains a repeat rule, and still edits it otherwise", async () => {
      const id = await seedEvent(lapsedGroup);
      const res = await edit("member", id, {
        changes: {
          repeat: { freq: "weekly", interval: 1, weekdays: [3], monthlyMode: null, until: null },
        },
      }).expect(402);

      expect(res.body.errors[0].context).toEqual({
        reason: "PLAN_LIMIT",
        code: "GROUP_EVENTS_PLAN_REQUIRED",
      });
      expect(await loadEvent(id)).toMatchObject({ repeatFreq: null, repeatInterval: null });

      await edit("member", id, { changes: { title: "Renamed" } }).expect(200);
      expect(await loadEvent(id)).toMatchObject({ title: "Renamed", repeatFreq: null });
    });
  });

  describe("DELETE /api/group-events/:id", () => {
    const remove = (id: string, query: Record<string, string> = {}) =>
      as("member").delete(`/api/group-events/${id}`).query(query);

    const expectTombstone = (row: typeof groupEvents.$inferSelect) =>
      expect(row).toMatchObject({
        title: null,
        note: null,
        startTime: null,
        endTime: null,
        repeatFreq: null,
        repeatInterval: null,
        repeatWeekdays: null,
        repeatMonthlyMode: null,
        repeatUntil: null,
        skippedDates: [],
        createdByUserId: null,
        deletedAt: expect.any(Date),
      });

    it("skips one occurrence with this event", async () => {
      const id = await seedWeekly();
      const res = await remove(id, { scope: "this", occurrenceDate: "2026-11-10" }).expect(200);

      expect(res.body.deletedIds).toEqual([]);
      expect(res.body.events[0].skippedDates).toEqual(["2026-11-10"]);
      expect(await loadEvent(id)).toMatchObject({ skippedDates: ["2026-11-10"], deletedAt: null });
    });

    it("tombstones a one-off, a linked one leaving its date skipped", async () => {
      const id = await seedWeekly();
      const created = await edit("member", id, {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: { title: "Moved", note: "Bring cake" },
      }).expect(200);
      const oneOff = (created.body.events as EventRow[]).find((row) => row.id !== id)!.id;

      const res = await remove(oneOff).expect(200);

      expect(res.body.deletedIds).toEqual([oneOff]);
      const tombstone = await loadEvent(oneOff);
      expectTombstone(tombstone);
      expect(tombstone).toMatchObject({
        groupId: proGroup,
        startDate: "2026-11-10",
        endDate: "2026-11-10",
        recurringEventId: id,
        originalDate: "2026-11-10",
      });
      expect(await loadEvent(id)).toMatchObject({ skippedDates: ["2026-11-10"] });
    });

    it("ends the event the day before with this and following, deleting later one-offs", async () => {
      const id = await seedWeekly();
      const created = await edit("member", id, {
        scope: "this",
        occurrenceDate: "2026-11-24",
        changes: { title: "Later" },
      }).expect(200);
      const later = (created.body.events as EventRow[]).find((row) => row.id !== id)!.id;

      const res = await remove(id, { scope: "following", occurrenceDate: "2026-11-17" }).expect(
        200
      );

      expect(res.body.deletedIds).toEqual([later]);
      expect(await loadEvent(id)).toMatchObject({
        repeatUntil: "2026-11-16",
        skippedDates: [],
        deletedAt: null,
      });
      expectTombstone(await loadEvent(later));
    });

    it("tombstones the event and its one-offs with all events, keeping ids, group and dates", async () => {
      const id = await seedWeekly(proGroup, { note: "Daily", skippedDates: ["2026-11-17"] });
      const created = await edit("member", id, {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: { title: "Moved" },
      }).expect(200);
      const oneOff = (created.body.events as EventRow[]).find((row) => row.id !== id)!.id;
      const before = await loadEvent(id);

      const res = await remove(id, { scope: "all" }).expect(200);

      expect(res.body).toEqual({ droppedOneOffs: 0, events: [], deletedIds: [id, oneOff] });
      const tombstone = await loadEvent(id);
      expectTombstone(tombstone);
      expect(tombstone).toMatchObject({
        id,
        groupId: proGroup,
        startDate: "2026-11-03",
        endDate: "2026-11-03",
      });
      expect(tombstone.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expectTombstone(await loadEvent(oneOff));

      const listed = (await listNovember("member", proGroup)).map((row) => row.id);
      expect(listed).not.toContain(id);
      expect(listed).not.toContain(oneOff);
      await remove(id, { scope: "all" }).expect(404);
    });

    it("refuses a recurring group event without a scope", async () => {
      const id = await seedWeekly();
      await remove(id).expect(422);
      await remove(id, { scope: "following" }).expect(422);
    });
  });
});
