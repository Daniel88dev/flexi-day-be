import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import {
  groupEventMonthlyMode,
  groupEventRepeatFreq,
  groupEvents,
} from "../../db/schema/group-event-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { encodeSyncCursor } from "../../services/sync/syncCursor.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addMember,
  ageEverything,
  makeGroup,
  makeUser,
  removeMember,
  resetReportData,
} from "./helpers/reportFixtures.js";

type GroupEventRow = {
  id: string;
  groupId: string;
  organizationId: string;
  createdByUserId: string | null;
  title: string | null;
  note: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  repeatFreq: string | null;
  repeatInterval: number | null;
  repeatWeekdays: number[] | null;
  repeatMonthlyMode: string | null;
  repeatUntil: string | null;
  skippedDates: string[];
  recurringEventId: string | null;
  originalDate: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type SyncBody = {
  reset: boolean;
  hasMore: boolean;
  users: { id: string }[];
  groupEvents: GroupEventRow[];
};

const MINUTE = 60 * 1000;

/** Old enough that only a change made after `ageEverything` lands in the window. */
const staleCursor = (): string => encodeSyncCursor(new Date(Date.now() - 10 * MINUTE));

const idsOf = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe("Sync pull group events E2E", () => {
  let server: LoopbackServer;

  const pull = async (userId: string, cursor?: string): Promise<SyncBody> => {
    const call = request(server.url)
      .get("/api/sync/pull")
      .set("Cookie", await authCookieFor(userId));
    const res = await (cursor === undefined ? call : call.query({ cursor })).expect(200);
    return res.body as SyncBody;
  };

  /** A paid group with a manager, a view-only member and a plain member. */
  const seedGroup = async () => {
    const manager = await makeUser("Manager");
    const viewer = await makeUser("Viewer");
    const member = await makeUser("Member");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, viewer.id, { viewAccess: true });
    await addMember(groupId, member.id);
    const organization = await ensureOrganizationForUser(manager.id);
    await upsertSubscription(organization.id, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    return { manager, viewer, member, groupId, organizationId: organization.id };
  };

  const seedEvent = async (
    groupId: string,
    createdByUserId: string,
    values: Partial<typeof groupEvents.$inferInsert> = {}
  ): Promise<string> => {
    const id = uuidv4();
    await db.insert(groupEvents).values({
      id,
      groupId,
      createdByUserId,
      title: "Offsite",
      startDate: "2026-11-12",
      endDate: "2026-11-13",
      ...values,
    });
    return id;
  };

  // Tuesday 3 November 2026, weekly on Tuesdays, 09:00 to 09:30.
  const seedWeekly = (groupId: string, createdByUserId: string) =>
    seedEvent(groupId, createdByUserId, {
      title: "Standup",
      note: "Bring coffee",
      startDate: "2026-11-03",
      endDate: "2026-11-03",
      startTime: "09:00",
      endTime: "09:30",
      repeatFreq: groupEventRepeatFreq.Weekly,
      repeatInterval: 1,
      repeatWeekdays: [1],
      repeatUntil: "2026-12-29",
    });

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

  describe("a snapshot", () => {
    it("ships the caller's groups' events, recurring and one-off, as stored", async () => {
      const { viewer, member, groupId, organizationId } = await seedGroup();
      const weeklyId = await seedWeekly(groupId, member.id);
      const offsiteId = await seedEvent(groupId, member.id);

      const body = await pull(viewer.id);

      expect(body.reset).toBe(true);
      expect(idsOf(body.groupEvents)).toEqual([weeklyId, offsiteId].sort());
      expect(body.groupEvents.find((row) => row.id === weeklyId)).toEqual({
        id: weeklyId,
        groupId,
        organizationId,
        createdByUserId: member.id,
        title: "Standup",
        note: "Bring coffee",
        startDate: "2026-11-03",
        endDate: "2026-11-03",
        startTime: "09:00",
        endTime: "09:30",
        repeatFreq: "WEEKLY",
        repeatInterval: 1,
        repeatWeekdays: [1],
        repeatMonthlyMode: null,
        repeatUntil: "2026-12-29",
        skippedDates: [],
        recurringEventId: null,
        originalDate: null,
        deletedAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(body.groupEvents.find((row) => row.id === offsiteId)).toMatchObject({
        title: "Offsite",
        startDate: "2026-11-12",
        endDate: "2026-11-13",
        startTime: null,
        endTime: null,
        repeatFreq: null,
        repeatInterval: null,
        repeatWeekdays: null,
      });
    });

    it("ships them to a plain member too, and none to somebody outside the group", async () => {
      const { member, groupId } = await seedGroup();
      const outsider = await makeUser("Outsider");
      const otherGroup = await makeGroup("Sales", outsider.id);
      await addMember(otherGroup, outsider.id, { viewAccess: true });
      const eventId = await seedWeekly(groupId, member.id);

      expect(idsOf((await pull(member.id)).groupEvents)).toEqual([eventId]);
      expect((await pull(outsider.id)).groupEvents).toEqual([]);
    });

    it("leaves tombstones out", async () => {
      const { viewer, member, groupId } = await seedGroup();
      const liveId = await seedEvent(groupId, member.id);
      await seedEvent(groupId, member.id, {
        title: null,
        createdByUserId: null,
        deletedAt: new Date(),
      });

      expect(idsOf((await pull(viewer.id)).groupEvents)).toEqual([liveId]);
    });

    it("names every creator in users, one who left and an admin who is no member included", async () => {
      const { manager, member, groupId } = await seedGroup();
      const plain = await makeUser("Plain");
      await addMember(groupId, plain.id);
      const leaver = await makeUser("Leaver");
      await addMember(groupId, leaver.id);
      await seedEvent(groupId, leaver.id);
      await removeMember(groupId, leaver.id);
      await seedEvent(groupId, manager.id);
      await seedWeekly(groupId, member.id);

      const userIds = (await pull(plain.id)).users.map((row) => row.id);

      expect(userIds).toEqual(expect.arrayContaining([leaver.id, manager.id, member.id]));
    });

    it("answers a reset carrying the group events to a cursor minted before they shipped", async () => {
      const { viewer, member, groupId } = await seedGroup();
      const eventId = await seedWeekly(groupId, member.id);
      await ageEverything();
      const beforeGroupEvents = Buffer.from(
        JSON.stringify({ v: 3, t: new Date(Date.now() - 10 * MINUTE).toISOString() }),
        "utf8"
      ).toString("base64url");

      const body = await pull(viewer.id, beforeGroupEvents);

      expect(body.reset).toBe(true);
      expect(idsOf(body.groupEvents)).toEqual([eventId]);
    });
  });

  describe("a delta", () => {
    const edit = async (userId: string, id: string, body: Record<string, unknown>) =>
      request(server.url)
        .patch(`/api/group-events/${id}`)
        .set("Cookie", await authCookieFor(userId))
        .send(body)
        .expect(200);

    const remove = async (userId: string, id: string, query: Record<string, string>) =>
      request(server.url)
        .delete(`/api/group-events/${id}`)
        .set("Cookie", await authCookieFor(userId))
        .query(query)
        .expect(200);

    it("ships only the group events changed since the cursor", async () => {
      const { viewer, member, groupId } = await seedGroup();
      const editedId = await seedEvent(groupId, member.id);
      await seedWeekly(groupId, member.id);
      await ageEverything();

      await edit(member.id, editedId, { changes: { title: "Offsite, Prague" } });
      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.groupEvents).toHaveLength(1);
      expect(body.groupEvents[0]).toMatchObject({ id: editedId, title: "Offsite, Prague" });
    });

    it("ships a this event edit as the skipped date and the new linked one-off", async () => {
      const { viewer, member, groupId } = await seedGroup();
      const weeklyId = await seedWeekly(groupId, member.id);
      await ageEverything();

      await edit(member.id, weeklyId, {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: { startTime: "10:00", endTime: "10:30" },
      });
      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.groupEvents).toHaveLength(2);
      expect(body.groupEvents.find((row) => row.id === weeklyId)).toMatchObject({
        repeatFreq: "WEEKLY",
        skippedDates: ["2026-11-10"],
        deletedAt: null,
      });
      expect(body.groupEvents.find((row) => row.id !== weeklyId)).toMatchObject({
        groupId,
        createdByUserId: member.id,
        title: "Standup",
        startDate: "2026-11-10",
        endDate: "2026-11-10",
        startTime: "10:00",
        endTime: "10:30",
        repeatFreq: null,
        recurringEventId: weeklyId,
        originalDate: "2026-11-10",
        deletedAt: null,
      });
    });

    it("ships the tombstones of a deleted recurring group event and its one-offs", async () => {
      const { viewer, member, groupId, organizationId } = await seedGroup();
      const weeklyId = await seedWeekly(groupId, member.id);
      await edit(member.id, weeklyId, {
        scope: "this",
        occurrenceDate: "2026-11-10",
        changes: { title: "Standup with guests" },
      });
      await ageEverything();

      await remove(member.id, weeklyId, { scope: "all" });
      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.groupEvents).toHaveLength(2);
      expect(body.groupEvents.find((row) => row.id === weeklyId)).toEqual({
        id: weeklyId,
        groupId,
        organizationId,
        createdByUserId: null,
        title: null,
        note: null,
        startDate: "2026-11-03",
        endDate: "2026-11-03",
        startTime: null,
        endTime: null,
        repeatFreq: null,
        repeatInterval: null,
        repeatWeekdays: null,
        repeatMonthlyMode: null,
        repeatUntil: null,
        skippedDates: [],
        recurringEventId: null,
        originalDate: null,
        deletedAt: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(body.groupEvents.find((row) => row.id !== weeklyId)).toMatchObject({
        title: null,
        recurringEventId: weeklyId,
        originalDate: "2026-11-10",
        deletedAt: expect.any(String),
      });
    });

    it("ships a monthly rule's mode as stored", async () => {
      const { viewer, member, groupId } = await seedGroup();
      await ageEverything();
      const id = await seedEvent(groupId, member.id, {
        title: "Planning",
        startDate: "2026-10-13",
        endDate: "2026-10-13",
        repeatFreq: groupEventRepeatFreq.Monthly,
        repeatInterval: 1,
        repeatMonthlyMode: groupEventMonthlyMode.NthWeekday,
        skippedDates: ["2026-12-08", "2026-11-10"],
      });

      const [row] = (await pull(viewer.id, staleCursor())).groupEvents;

      expect(row).toMatchObject({
        id,
        repeatFreq: "MONTHLY",
        repeatMonthlyMode: "NTH_WEEKDAY",
        repeatWeekdays: null,
        skippedDates: ["2026-11-10", "2026-12-08"],
      });
    });

    it("names the creator of an event changed since the cursor in users", async () => {
      const { manager, groupId } = await seedGroup();
      const plain = await makeUser("Plain");
      await addMember(groupId, plain.id);
      const leaver = await makeUser("Leaver");
      await addMember(groupId, leaver.id);
      const eventId = await seedEvent(groupId, leaver.id);
      await removeMember(groupId, leaver.id);
      await ageEverything();

      await edit(manager.id, eventId, { changes: { note: "Moved to the big room" } });
      const body = await pull(plain.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.groupEvents.map((row) => row.id)).toEqual([eventId]);
      expect(body.users.map((row) => row.id)).toContain(leaver.id);
    });
  });
});
