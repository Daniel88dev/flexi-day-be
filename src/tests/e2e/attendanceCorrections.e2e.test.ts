import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { and, asc, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  attendanceBreaks,
  attendanceClosedBy,
  attendanceEvents,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  balanceMode,
  organizationAttendanceSettings,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { businessDateInZone } from "../../utils/dateFunc.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE = "Europe/Prague";

/** Today and yesterday in the organization's zone: the two sides of the self-service window. */
const today = () => businessDateInZone(new Date(), ZONE);
const yesterday = () => businessDateInZone(new Date(Date.now() - DAY_MS), ZONE);

/** An instant a given number of hours back, so seeded times are always in the past. */
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

let ORGANIZATION_ID: string;

type Person = { id: string; name: string };

describe("attendance corrections", () => {
  let app: Express;

  let owner: Person;
  let groupAdmin: Person;
  let member: Person;
  /** Administers Sales, so the member's Employment is none of their business. */
  let salesAdmin: Person;

  const cookies = new Map<string, string>();
  const employmentIds = new Map<string, string>();

  const cookieOf = (person: Person) => cookies.get(person.id)!;

  const patchSession = (person: Person, sessionId: string, body: unknown) =>
    request(app)
      .patch(`/api/attendance/sessions/${sessionId}`)
      .set("Cookie", cookieOf(person))
      .send(body);

  const deleteSession = (person: Person, sessionId: string) =>
    request(app).delete(`/api/attendance/sessions/${sessionId}`).set("Cookie", cookieOf(person));

  const patchBreak = (person: Person, breakId: string, body: unknown) =>
    request(app)
      .patch(`/api/attendance/breaks/${breakId}`)
      .set("Cookie", cookieOf(person))
      .send(body);

  const deleteBreak = (person: Person, breakId: string) =>
    request(app).delete(`/api/attendance/breaks/${breakId}`).set("Cookie", cookieOf(person));

  const events = (person: Person, sessionId: string) =>
    request(app)
      .get(`/api/attendance/sessions/${sessionId}/events`)
      .set("Cookie", cookieOf(person));

  const seedSession = async (input: {
    person: Person;
    businessDate: string;
    startedAt: Date;
    endedAt: Date | null;
    closedBy?: attendanceClosedBy | null;
    breaks?: { startedAt: Date; endedAt: Date | null; autoClosed?: boolean }[];
  }) => {
    const id = uuidv4();
    await db.insert(attendanceSessions).values({
      id,
      employmentId: employmentIds.get(input.person.id)!,
      businessDate: input.businessDate,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      timezone: ZONE,
      closedBy:
        input.closedBy === undefined
          ? input.endedAt
            ? attendanceClosedBy.User
            : null
          : input.closedBy,
    });

    const breakIds: string[] = [];
    for (const entry of input.breaks ?? []) {
      const breakId = uuidv4();
      breakIds.push(breakId);
      await db.insert(attendanceBreaks).values({
        id: breakId,
        sessionId: id,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        autoClosed: entry.autoClosed ?? false,
      });
    }

    return { id, breakIds };
  };

  const sessionRow = async (sessionId: string) => {
    const [row] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, sessionId));
    return row;
  };

  const eventRows = async (sessionId: string) =>
    db
      .select({
        eventType: attendanceEvents.eventType,
        changedByUserId: attendanceEvents.changedByUserId,
        before: attendanceEvents.before,
        after: attendanceEvents.after,
      })
      .from(attendanceEvents)
      .where(eq(attendanceEvents.sessionId, sessionId))
      .orderBy(asc(attendanceEvents.createdAt));

  const proActive = () =>
    upsertSubscription(ORGANIZATION_ID, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    const make = async (email: string, name: string): Promise<Person> => {
      const user = await createTestUser(email, name, "password123");
      return { id: user.id, name };
    };

    owner = await make("correction-owner@test.com", "Olivia Owner");
    groupAdmin = await make("correction-admin@test.com", "Gina Groupadmin");
    member = await make("correction-member@test.com", "Milo Member");
    salesAdmin = await make("correction-sales@test.com", "Sam Salesadmin");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    const engineeringId = uuidv4();
    await db.insert(groups).values({
      id: engineeringId,
      organizationId: ORGANIZATION_ID,
      groupName: "Engineering",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });
    const salesId = uuidv4();
    await db.insert(groups).values({
      id: salesId,
      organizationId: ORGANIZATION_ID,
      groupName: "Sales",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });

    const memberships: [Person, string, boolean][] = [
      [groupAdmin, engineeringId, true],
      [member, engineeringId, false],
      [salesAdmin, salesId, true],
    ];
    for (const [person, groupId, adminAccess] of memberships) {
      await db.insert(groupUsers).values({
        id: uuidv4(),
        userId: person.id,
        groupId,
        viewAccess: true,
        adminAccess,
        approverAccess: false,
        controlledUser: true,
      });
    }

    for (const person of [owner, groupAdmin, member, salesAdmin]) {
      await syncEmployment(ORGANIZATION_ID, person.id);
      cookies.set(person.id, await authCookieFor(person.id));
      const [row] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(
          and(eq(employments.organizationId, ORGANIZATION_ID), eq(employments.userId, person.id))
        );
      employmentIds.set(person.id, row!.id);
    }
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(attendanceSessions);
    await db.delete(organizationAttendanceSettings);
    await upsertAttendanceSettings(ORGANIZATION_ID, {
      ...ATTENDANCE_SETTINGS_DEFAULTS,
      balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
      attendanceEnabled: true,
      timezone: ZONE,
    });
    await proActive();
  });

  describe("an admin correcting somebody's day", () => {
    it("moves both ends and leaves one event behind", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });

      const startedAt = hoursAgo(29);
      const endedAt = hoursAgo(21);

      const { body } = await patchSession(owner, id, {
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      }).expect(200);

      expect(body).toMatchObject({ id, open: false, closedBy: "ADMIN" });
      expect(new Date(body.startedAt as string).toISOString()).toBe(startedAt.toISOString());
      expect(new Date(body.endedAt as string).toISOString()).toBe(endedAt.toISOString());

      const written = await eventRows(id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        eventType: "SESSION_EDITED",
        changedByUserId: owner.id,
      });
      expect(written[0]!.after).toMatchObject({ closedBy: "ADMIN" });
    });

    it("keeps the business date where it was", async () => {
      const date = yesterday();
      const { id } = await seedSession({
        person: member,
        businessDate: date,
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });

      const { body } = await patchSession(owner, id, {
        startedAt: hoursAgo(50).toISOString(),
      }).expect(200);

      expect(body.businessDate).toBe(date);
    });

    it("clears the sweep's mark once the end has been corrected", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(14),
        closedBy: attendanceClosedBy.Sweep,
      });

      const kept = await patchSession(owner, id, {
        startedAt: hoursAgo(31).toISOString(),
      }).expect(200);
      expect(kept.body.closedBy).toBe("SWEEP");

      const corrected = await patchSession(owner, id, {
        endedAt: hoursAgo(21).toISOString(),
      }).expect(200);
      expect(corrected.body.closedBy).toBe("ADMIN");
    });

    it("corrects a break and clears its auto-closed flag", async () => {
      const { id, breakIds } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
        breaks: [{ startedAt: hoursAgo(26), endedAt: hoursAgo(24), autoClosed: true }],
      });
      const breakId = breakIds[0]!;

      const { body } = await patchBreak(groupAdmin, breakId, {
        startedAt: hoursAgo(26).toISOString(),
        endedAt: hoursAgo(25.5).toISOString(),
      }).expect(200);

      expect(body.id).toBe(id);
      expect(body.breaks).toHaveLength(1);
      expect(body.breaks[0]).toMatchObject({ id: breakId, autoClosed: false, open: false });

      const written = await eventRows(id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        eventType: "BREAK_EDITED",
        changedByUserId: groupAdmin.id,
      });
    });

    it("removes a break and keeps only the event that says it was there", async () => {
      const { id, breakIds } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
        breaks: [{ startedAt: hoursAgo(26), endedAt: hoursAgo(24) }],
      });

      const { body } = await deleteBreak(owner, breakIds[0]!).expect(200);
      expect(body.breaks).toHaveLength(0);

      const written = await eventRows(id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        eventType: "BREAK_DELETED",
        changedByUserId: owner.id,
      });
      expect(written[0]!.before).toMatchObject({ breakId: breakIds[0] });
    });

    it("soft-deletes a session, leaving the row and its events standing", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });

      await deleteSession(owner, id).expect(200);

      const row = await sessionRow(id);
      expect(row).toBeDefined();
      expect(row!.deletedAt).not.toBeNull();
      expect(row!.deletedByUserId).toBe(owner.id);

      const written = await eventRows(id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        eventType: "SESSION_DELETED",
        changedByUserId: owner.id,
      });

      // Gone from every read, and no longer correctable.
      await patchSession(owner, id, { startedAt: hoursAgo(29).toISOString() }).expect(404);
      const { body } = await events(owner, id).expect(200);
      expect(body.events).toHaveLength(1);
    });
  });

  describe("who may correct what", () => {
    it("lets the employee correct their own session inside the window", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: today(),
        startedAt: hoursAgo(6),
        endedAt: hoursAgo(1),
      });

      const { body } = await patchSession(member, id, {
        endedAt: hoursAgo(0.5).toISOString(),
      }).expect(200);

      expect(body.closedBy).toBe("USER");
    });

    it("lets the employee correct a session that is still open, however old", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: null,
      });

      await patchSession(member, id, { startedAt: hoursAgo(29).toISOString() }).expect(200);
    });

    it("refuses the employee an older day and names the admin route", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });

      const { body } = await patchSession(member, id, {
        endedAt: hoursAgo(21).toISOString(),
      }).expect(403);

      expect(body.errors[0].context.reason).toBe("SELF_SERVICE_WINDOW");
      expect(body.errors[0].message).toMatch(/admin/i);

      await deleteSession(member, id).expect(403);
    });

    it("refuses a group admin of another group", async () => {
      const { id, breakIds } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
        breaks: [{ startedAt: hoursAgo(26), endedAt: hoursAgo(24) }],
      });

      await patchSession(salesAdmin, id, { endedAt: hoursAgo(21).toISOString() }).expect(403);
      await patchBreak(salesAdmin, breakIds[0]!, {
        endedAt: hoursAgo(25).toISOString(),
      }).expect(403);
      await deleteBreak(salesAdmin, breakIds[0]!).expect(403);
      await deleteSession(salesAdmin, id).expect(403);
      await events(salesAdmin, id).expect(403);

      expect(await eventRows(id)).toHaveLength(0);
    });

    it("refuses every correction once the plan has lapsed", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });

      await upsertSubscription(ORGANIZATION_ID, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() - DAY_MS),
      });

      await patchSession(owner, id, { endedAt: hoursAgo(21).toISOString() }).expect(402);
      // The history stays readable.
      await events(owner, id).expect(200);
    });
  });

  describe("what a correction may not leave behind", () => {
    it("refuses an end at or before its start", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });

      const { body } = await patchSession(owner, id, {
        endedAt: hoursAgo(31).toISOString(),
      }).expect(422);

      expect(body.errors[0].context.reason).toBe("END_BEFORE_START");
      expect(await eventRows(id)).toHaveLength(0);
    });

    it("refuses times that would leave a break outside its session", async () => {
      const { id, breakIds } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
        breaks: [{ startedAt: hoursAgo(26), endedAt: hoursAgo(24) }],
      });

      const shrunk = await patchSession(owner, id, {
        startedAt: hoursAgo(25).toISOString(),
      }).expect(422);
      expect(shrunk.body.errors[0].context.reason).toBe("BREAK_OUTSIDE_SESSION");

      const moved = await patchBreak(owner, breakIds[0]!, {
        endedAt: hoursAgo(21).toISOString(),
      }).expect(422);
      expect(moved.body.errors[0].context.reason).toBe("BREAK_OUTSIDE_SESSION");
    });

    it("refuses reopening a session while another of that person's is open", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });
      const open = await seedSession({
        person: member,
        businessDate: today(),
        startedAt: hoursAgo(4),
        endedAt: null,
      });

      const { body } = await patchSession(owner, id, { endedAt: null }).expect(409);

      expect(body.errors[0].context).toMatchObject({
        reason: "SESSION_ALREADY_OPEN",
        sessionId: open.id,
      });
      expect(await eventRows(id)).toHaveLength(0);
    });

    it("reopens a session when nothing else of that person's is open", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: today(),
        startedAt: hoursAgo(4),
        endedAt: hoursAgo(1),
      });

      const { body } = await patchSession(member, id, { endedAt: null }).expect(200);

      expect(body).toMatchObject({ open: true, endedAt: null, closedBy: null });
    });

    it("refuses reopening a break while another on the session is open", async () => {
      const { breakIds } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: null,
        breaks: [
          { startedAt: hoursAgo(26), endedAt: hoursAgo(25) },
          { startedAt: hoursAgo(24), endedAt: null },
        ],
      });

      const { body } = await patchBreak(owner, breakIds[0]!, { endedAt: null }).expect(409);

      expect(body.errors[0].context).toMatchObject({
        reason: "BREAK_ALREADY_OPEN",
        breakId: breakIds[1],
      });
    });

    it("refuses a patch that changes nothing", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });

      await patchSession(owner, id, {}).expect(422);
    });
  });

  describe("the day a dialog opens onto", () => {
    const day = (person: Person, query: Record<string, string>) =>
      request(app)
        .get("/api/attendance/day")
        .query({ organizationId: ORGANIZATION_ID, ...query })
        .set("Cookie", cookieOf(person));

    it("gives an admin somebody else's sessions with their breaks", async () => {
      const date = yesterday();
      const { id, breakIds } = await seedSession({
        person: member,
        businessDate: date,
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
        breaks: [{ startedAt: hoursAgo(26), endedAt: hoursAgo(24) }],
      });

      const { body } = await day(owner, { userId: member.id, businessDate: date }).expect(200);

      expect(body).toMatchObject({ userId: member.id, businessDate: date, timezone: ZONE });
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe(id);
      expect(body.sessions[0].breaks[0].id).toBe(breakIds[0]);
    });

    it("defaults to the caller and drops a deleted session", async () => {
      const date = today();
      const { id } = await seedSession({
        person: member,
        businessDate: date,
        startedAt: hoursAgo(6),
        endedAt: hoursAgo(1),
      });

      const before = await day(member, { businessDate: date }).expect(200);
      expect(before.body.sessions).toHaveLength(1);

      await deleteSession(member, id).expect(200);

      const after = await day(member, { businessDate: date }).expect(200);
      expect(after.body.sessions).toHaveLength(0);
    });

    it("refuses a group admin of another group", async () => {
      await day(salesAdmin, { userId: member.id, businessDate: yesterday() }).expect(403);
    });
  });

  describe("the timeline", () => {
    it("names the actor on each entry and leaves the sweep without one", async () => {
      const { id, breakIds } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(14),
        closedBy: attendanceClosedBy.Sweep,
        breaks: [{ startedAt: hoursAgo(26), endedAt: hoursAgo(24) }],
      });

      await db.insert(attendanceEvents).values({
        id: uuidv4(),
        sessionId: id,
        eventType: "CLOCK_OUT",
        changedByUserId: null,
        before: null,
        after: { closedBy: "SWEEP" },
      });

      await patchSession(owner, id, { endedAt: hoursAgo(21).toISOString() }).expect(200);
      await patchBreak(owner, breakIds[0]!, {
        endedAt: hoursAgo(23.5).toISOString(),
      }).expect(200);

      const { body } = await events(member, id).expect(200);

      expect(body.sessionId).toBe(id);
      expect(body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
        "CLOCK_OUT",
        "SESSION_EDITED",
        "BREAK_EDITED",
      ]);
      expect(body.events[0].user).toBeNull();
      expect(body.events[1].user).toMatchObject({ id: owner.id, name: owner.name });
      expect(body.events[2].user).toMatchObject({ id: owner.id });
    });

    it("lets the person read their own history long after the window has closed", async () => {
      const { id } = await seedSession({
        person: member,
        businessDate: yesterday(),
        startedAt: hoursAgo(30),
        endedAt: hoursAgo(22),
      });

      await patchSession(owner, id, { endedAt: hoursAgo(21).toISOString() }).expect(200);

      const { body } = await events(member, id).expect(200);
      expect(body.events).toHaveLength(1);
    });
  });
});
