import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { attendanceEvents, attendanceSessions } from "../../db/schema/attendance-schema.js";
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
const EMPLOYED_SINCE = new Date("2020-01-01T00:00:00Z");

const today = () => businessDateInZone(new Date(), ZONE);

/** The calendar date a number of days before another, stepped as dates rather than as real time. */
const daysBefore = (date: string, days: number) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
};

/**
 * A UTC instant on a date. Between 00:00 and 21:59 UTC the date in Prague is
 * the same one, which is all the entries below rely on.
 */
const at = (date: string, time: string) => `${date}T${time}:00.000Z`;

let ORGANIZATION_ID: string;

type Person = { id: string; name: string };

describe("entered attendance sessions", () => {
  let app: Express;

  let owner: Person;
  let groupAdmin: Person;
  let member: Person;
  let salesAdmin: Person;
  /** Manages Design and belongs to no group, so only an org admin can see them. */
  let loner: Person;

  const cookies = new Map<string, string>();
  const employmentIds = new Map<string, string>();

  const cookieOf = (person: Person) => cookies.get(person.id)!;

  const enter = (
    person: Person,
    body: {
      userId?: string;
      businessDate: string;
      startedAt: string;
      endedAt: string;
      breaks?: { startedAt: string; endedAt: string }[];
    }
  ) =>
    request(app)
      .post("/api/attendance/sessions")
      .set("Cookie", cookieOf(person))
      .send({ organizationId: ORGANIZATION_ID, ...body });

  /** A plain eight-hour day, some whole days back. */
  const dayBack = (days: number) => {
    const businessDate = daysBefore(today(), days);
    return {
      businessDate,
      startedAt: at(businessDate, "07:00"),
      endedAt: at(businessDate, "15:00"),
    };
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

  const sessionsOf = (person: Person) =>
    db
      .select()
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.employmentId, employmentIds.get(person.id)!),
          isNull(attendanceSessions.deletedAt)
        )
      )
      .orderBy(asc(attendanceSessions.startedAt));

  const setWindow = (selfServiceEnabled: boolean, selfServiceDays: number | null) =>
    db
      .update(organizationAttendanceSettings)
      .set({ selfServiceEnabled, selfServiceDays })
      .where(eq(organizationAttendanceSettings.organizationId, ORGANIZATION_ID));

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    const make = async (email: string, name: string): Promise<Person> => {
      const user = await createTestUser(email, name, "password123");
      return { id: user.id, name };
    };

    owner = await make("entry-owner@test.com", "Olivia Owner");
    groupAdmin = await make("entry-admin@test.com", "Gina Groupadmin");
    member = await make("entry-member@test.com", "Milo Member");
    salesAdmin = await make("entry-sales@test.com", "Sam Salesadmin");
    loner = await make("entry-loner@test.com", "Lena Loner");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    const groupOf = async (groupName: string, managerUserId: string) => {
      const id = uuidv4();
      await db.insert(groups).values({
        id,
        organizationId: ORGANIZATION_ID,
        groupName,
        managerUserId,
        mainApprovalUser: managerUserId,
      });
      return id;
    };
    const engineeringId = await groupOf("Engineering", owner.id);
    const salesId = await groupOf("Sales", owner.id);
    await groupOf("Design", loner.id);

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

    for (const person of [owner, groupAdmin, member, salesAdmin, loner]) {
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
    await db
      .update(employments)
      .set({ startedAt: EMPLOYED_SINCE, endedAt: null })
      .where(eq(employments.organizationId, ORGANIZATION_ID));
    await db.delete(organizationAttendanceSettings);
    await upsertAttendanceSettings(ORGANIZATION_ID, {
      ...ATTENDANCE_SETTINGS_DEFAULTS,
      balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
      attendanceEnabled: true,
      timezone: ZONE,
      workingDays: [1, 2, 3, 4, 5],
      holidayCountry: null,
      selfServiceEnabled: true,
      selfServiceDays: 7,
    });
    await upsertSubscription(ORGANIZATION_ID, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
  });

  describe("who may enter a session", () => {
    it("lets a group admin enter one for a member of their group, as entered", async () => {
      const entry = dayBack(3);

      const { body } = await enter(groupAdmin, { userId: member.id, ...entry }).expect(201);

      expect(body).toMatchObject({
        businessDate: entry.businessDate,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        timezone: ZONE,
        origin: "ENTERED",
        enteredByUserId: groupAdmin.id,
        open: false,
        breaks: [],
      });
      expect((await sessionsOf(member)).map((row) => row.id)).toEqual([body.id]);
    });

    it("lets an org admin enter one for somebody in no group", async () => {
      await enter(owner, { userId: loner.id, ...dayBack(3) }).expect(201);
      expect(await sessionsOf(loner)).toHaveLength(1);
    });

    it("refuses a group admin of another group, and a group admin somebody in no group", async () => {
      await enter(salesAdmin, { userId: member.id, ...dayBack(3) }).expect(403);
      await enter(groupAdmin, { userId: loner.id, ...dayBack(3) }).expect(403);

      expect(await sessionsOf(member)).toHaveLength(0);
      expect(await sessionsOf(loner)).toHaveLength(0);
    });

    it("lets an employee enter their own day inside the window, the caller by default", async () => {
      const { body } = await enter(member, dayBack(7)).expect(201);
      expect(body.origin).toBe("ENTERED");
    });

    it("refuses the employee a day outside the window", async () => {
      const { body } = await enter(member, dayBack(8)).expect(403);

      expect(body.errors[0].context.reason).toBe("SELF_SERVICE_WINDOW");
      expect(body.errors[0].message).toBe(
        "Only an admin can change a day this old. Ask a group admin, or an organization admin."
      );
    });

    it("refuses the employee with the window off, saying corrections go through an admin", async () => {
      await setWindow(false, 0);

      const { body } = await enter(member, dayBack(1)).expect(403);

      expect(body.errors[0].context.reason).toBe("SELF_SERVICE_OFF");
      expect(body.errors[0].message).toBe(
        "Your organization manages attendance corrections through an admin. Ask a group admin, or an organization admin."
      );
      expect(await sessionsOf(member)).toHaveLength(0);
    });

    it("refuses once the plan has lapsed", async () => {
      await upsertSubscription(ORGANIZATION_ID, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() - DAY_MS),
      });

      const { body } = await enter(owner, { userId: member.id, ...dayBack(3) }).expect(402);

      expect(body.errors[0].context.reason).toBe("PLAN_LIMIT");
      expect(await sessionsOf(member)).toHaveLength(0);
    });
  });

  describe("what an entry has to be", () => {
    const refusedWith = async (
      body: { businessDate: string; startedAt: string; endedAt: string },
      status: number,
      reason: string,
      message: string
    ) => {
      const answer = await enter(owner, { userId: member.id, ...body }).expect(status);
      expect(answer.body.errors[0].context.reason).toBe(reason);
      expect(answer.body.errors[0].message).toBe(message);
      return answer;
    };

    it("refuses a start on another day than the business date", async () => {
      const businessDate = daysBefore(today(), 3);
      await refusedWith(
        {
          businessDate,
          startedAt: at(daysBefore(today(), 2), "07:00"),
          endedAt: at(daysBefore(today(), 2), "15:00"),
        },
        422,
        "START_OFF_DATE",
        "The session has to start on the day it is entered for"
      );
    });

    it("refuses an end at or before its start", async () => {
      const businessDate = daysBefore(today(), 3);
      await refusedWith(
        { businessDate, startedAt: at(businessDate, "15:00"), endedAt: at(businessDate, "07:00") },
        422,
        "END_BEFORE_START",
        "A session has to end after it starts"
      );
    });

    it("refuses an end still to come", async () => {
      const startedAt = new Date(Date.now() - 60 * 60 * 1000);
      await refusedWith(
        {
          businessDate: businessDateInZone(startedAt, ZONE),
          startedAt: startedAt.toISOString(),
          endedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        422,
        "END_IN_FUTURE",
        "An entered session has to have ended already. Still working? Clock in, then correct the start."
      );
    });

    it("refuses a span longer than the session ceiling, naming it", async () => {
      const businessDate = daysBefore(today(), 3);
      const { body } = await refusedWith(
        {
          businessDate,
          startedAt: at(businessDate, "06:00"),
          endedAt: at(daysBefore(today(), 2), "00:00"),
        },
        422,
        "OVER_CEILING",
        "A session can't be longer than 16:00, the organization's session limit"
      );
      expect(body.errors[0].context.ceilingMinutes).toBe(960);
    });

    it("refuses a day outside the Employment's spell", async () => {
      await db
        .update(employments)
        .set({ startedAt: new Date(Date.now() - 2 * DAY_MS) })
        .where(eq(employments.id, employmentIds.get(member.id)!));

      await refusedWith(
        dayBack(5),
        422,
        "OUTSIDE_EMPLOYMENT",
        "That day is outside the employment"
      );
    });

    it("refuses a span over another session of theirs, an open one included", async () => {
      const entry = dayBack(3);
      await enter(owner, { userId: member.id, ...entry }).expect(201);

      const { body } = await refusedWith(
        {
          ...entry,
          startedAt: at(entry.businessDate, "14:00"),
          endedAt: at(entry.businessDate, "18:00"),
        },
        409,
        "SESSION_OVERLAPS",
        "Another session of theirs already covers that time"
      );
      expect(body.errors[0].context).toMatchObject({ startedAt: entry.startedAt });

      // Still clocked in since two hours ago: open runs to the end of time.
      await db.insert(attendanceSessions).values({
        id: uuidv4(),
        employmentId: employmentIds.get(member.id)!,
        businessDate: businessDateInZone(new Date(Date.now() - 2 * 60 * 60 * 1000), ZONE),
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        endedAt: null,
        timezone: ZONE,
      });
      const earlier = new Date(Date.now() - 60 * 60 * 1000);
      await refusedWith(
        {
          businessDate: businessDateInZone(earlier, ZONE),
          startedAt: earlier.toISOString(),
          endedAt: new Date(Date.now() - 1000).toISOString(),
        },
        409,
        "SESSION_OVERLAPS",
        "Another session of theirs already covers that time"
      );
    });

    it("allows a session that ends exactly where the next one starts", async () => {
      const entry = dayBack(3);
      await enter(owner, { userId: member.id, ...entry }).expect(201);

      await enter(owner, {
        userId: member.id,
        businessDate: entry.businessDate,
        startedAt: entry.endedAt,
        endedAt: at(entry.businessDate, "17:00"),
      }).expect(201);
    });

    it("keeps a session that crosses midnight on the day it started", async () => {
      const businessDate = daysBefore(today(), 3);
      const next = daysBefore(today(), 2);

      // 22:00 to 06:00 in Prague, summer or winter.
      await enter(owner, {
        userId: member.id,
        businessDate,
        startedAt: at(businessDate, "20:00"),
        endedAt: at(next, "04:00"),
      }).expect(201);

      const day = (businessDate: string) =>
        request(app)
          .get("/api/attendance/day")
          .query({ organizationId: ORGANIZATION_ID, userId: member.id, businessDate })
          .set("Cookie", cookieOf(owner))
          .expect(200);

      expect((await day(businessDate)).body.sessions).toHaveLength(1);
      expect((await day(next)).body.sessions).toHaveLength(0);
    });

    it("waits for the Employment lock a clock-in holds, then sees what it opened", async () => {
      const endedAt = new Date(Date.now() - 1000);
      const startedAt = new Date(endedAt.getTime() - 60 * 60 * 1000);
      const employmentId = employmentIds.get(member.id)!;

      let settled = false;
      let pending: Promise<request.Response> | undefined;

      // Stands in for a clock-in: it holds the row lock, opens a session inside
      // the entry's span, and commits only after the entry has had time to run.
      await db.transaction(async (tx) => {
        await tx
          .select({ id: employments.id })
          .from(employments)
          .where(eq(employments.id, employmentId))
          .for("update");

        pending = enter(owner, {
          userId: member.id,
          businessDate: businessDateInZone(startedAt, ZONE),
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
        }).then((response) => {
          settled = true;
          return response;
        });

        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);

        await tx.insert(attendanceSessions).values({
          id: uuidv4(),
          employmentId,
          businessDate: businessDateInZone(startedAt, ZONE),
          startedAt: new Date(startedAt.getTime() + 30 * 60 * 1000),
          endedAt: null,
          timezone: ZONE,
        });
      });

      const response = await pending!;
      expect(response.status).toBe(409);
      expect(response.body.errors[0].context.reason).toBe("SESSION_OVERLAPS");
      expect(await sessionsOf(member)).toHaveLength(1);
    });
  });

  describe("the reads", () => {
    it("report the entry as entered on the day and the team read, beside a clocked one", async () => {
      // A working day, so nothing but the entry could flag it.
      let back = 1;
      while ([0, 6].includes(new Date(`${daysBefore(today(), back)}T12:00:00Z`).getUTCDay())) {
        back += 1;
      }
      const entry = dayBack(back);
      await enter(owner, { userId: member.id, ...entry }).expect(201);
      await db.insert(attendanceSessions).values({
        id: uuidv4(),
        employmentId: employmentIds.get(loner.id)!,
        businessDate: entry.businessDate,
        startedAt: new Date(entry.startedAt),
        endedAt: new Date(entry.endedAt),
        timezone: ZONE,
        closedBy: "USER",
      });

      const day = await request(app)
        .get("/api/attendance/day")
        .query({
          organizationId: ORGANIZATION_ID,
          userId: member.id,
          businessDate: entry.businessDate,
        })
        .set("Cookie", cookieOf(owner))
        .expect(200);
      expect(day.body.sessions).toMatchObject([{ origin: "ENTERED", enteredByUserId: owner.id }]);

      const clocked = await request(app)
        .get("/api/attendance/day")
        .query({
          organizationId: ORGANIZATION_ID,
          userId: loner.id,
          businessDate: entry.businessDate,
        })
        .set("Cookie", cookieOf(owner))
        .expect(200);
      expect(clocked.body.sessions).toMatchObject([{ origin: "CLOCKED", enteredByUserId: null }]);

      const team = await request(app)
        .get("/api/attendance/team")
        .query({
          organizationId: ORGANIZATION_ID,
          from: entry.businessDate,
          to: entry.businessDate,
        })
        .set("Cookie", cookieOf(owner))
        .expect(200);
      const dayOf = (person: Person) =>
        team.body.people.find((row: { userId: string }) => row.userId === person.id).days[0];

      expect(dayOf(member)).toMatchObject({ entered: true, flagged: false, workedMinutes: 450 });
      expect(dayOf(loner)).toMatchObject({ entered: false });
    });

    it("flag an entry on an excluded day the way a clock-in on one is", async () => {
      // The most recent Saturday that has already ended.
      let saturday = daysBefore(today(), 1);
      while (new Date(`${saturday}T12:00:00Z`).getUTCDay() !== 6)
        saturday = daysBefore(saturday, 1);

      await enter(owner, {
        userId: member.id,
        businessDate: saturday,
        startedAt: at(saturday, "08:00"),
        endedAt: at(saturday, "10:00"),
      }).expect(201);

      const team = await request(app)
        .get("/api/attendance/team")
        .query({ organizationId: ORGANIZATION_ID, from: saturday, to: saturday })
        .set("Cookie", cookieOf(owner))
        .expect(200);
      const day = team.body.people.find((row: { userId: string }) => row.userId === member.id)
        .days[0];

      expect(day).toMatchObject({
        entered: true,
        excludedClockIn: true,
        flagged: true,
        workedMinutes: 120,
        exclusion: { cause: "NON_WORKING_DAY" },
      });
    });
  });

  describe("deleting an entered session", () => {
    const remove = (person: Person, sessionId: string) =>
      request(app).delete(`/api/attendance/sessions/${sessionId}`).set("Cookie", cookieOf(person));

    it("lets the employee delete one they entered on a past day inside the window", async () => {
      const { body } = await enter(member, dayBack(4)).expect(201);

      await remove(member, body.id as string).expect(200);

      expect(await sessionsOf(member)).toHaveLength(0);
      expect((await eventRows(body.id as string)).map((event) => event.eventType)).toEqual([
        "SESSION_CREATED",
        "SESSION_DELETED",
      ]);
    });

    it("refuses the employee one an admin entered for them on a past day", async () => {
      const { body } = await enter(owner, { userId: member.id, ...dayBack(4) }).expect(201);

      const refused = await remove(member, body.id as string).expect(403);
      expect(refused.body.errors[0].context.reason).toBe("SELF_SERVICE_DELETE_ENTERED");
      expect(refused.body.errors[0].message).toBe(
        "An admin entered this session. You can correct its times, but only an admin can delete it."
      );
    });

    it("refuses the employee one of theirs once the day has left the window", async () => {
      const { body } = await enter(member, dayBack(4)).expect(201);
      await setWindow(true, 2);

      const refused = await remove(member, body.id as string).expect(403);
      expect(refused.body.errors[0].context.reason).toBe("SELF_SERVICE_WINDOW");
    });
  });

  describe("an entry saved with its breaks", () => {
    it("saves the breaks with the session, each with its own BREAK_ADDED after the SESSION_CREATED", async () => {
      const entry = dayBack(3);
      const breaks = [
        { startedAt: at(entry.businessDate, "13:00"), endedAt: at(entry.businessDate, "13:10") },
        { startedAt: at(entry.businessDate, "10:00"), endedAt: at(entry.businessDate, "10:50") },
      ];

      const { body } = await enter(member, { ...entry, breaks }).expect(201);

      expect(body.breaks).toMatchObject([
        { startedAt: breaks[1]!.startedAt, endedAt: breaks[1]!.endedAt, open: false },
        { startedAt: breaks[0]!.startedAt, endedAt: breaks[0]!.endedAt, open: false },
      ]);

      const written = await eventRows(body.id as string);
      expect(written.map((event) => [event.eventType, event.changedByUserId])).toEqual([
        ["SESSION_CREATED", member.id],
        ["BREAK_ADDED", member.id],
        ["BREAK_ADDED", member.id],
      ]);
      expect(written.slice(1).map((event) => event.after)).toEqual([
        { breakId: expect.any(String), ...breaks[0] },
        { breakId: expect.any(String), ...breaks[1] },
      ]);

      const timeline = await request(app)
        .get(`/api/attendance/sessions/${body.id}/events`)
        .set("Cookie", cookieOf(member))
        .expect(200);
      expect(timeline.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
        "SESSION_CREATED",
        "BREAK_ADDED",
        "BREAK_ADDED",
      ]);
    });

    it("leaves no session behind when a break lies outside it", async () => {
      const entry = dayBack(3);

      const { body } = await enter(member, {
        ...entry,
        breaks: [
          { startedAt: at(entry.businessDate, "12:00"), endedAt: at(entry.businessDate, "12:30") },
          { startedAt: at(entry.businessDate, "14:45"), endedAt: at(entry.businessDate, "15:15") },
        ],
      }).expect(422);

      expect(body.errors[0].context.reason).toBe("BREAK_OUTSIDE_SESSION");
      expect(await sessionsOf(member)).toHaveLength(0);
    });

    it("leaves no session behind when two of its breaks overlap", async () => {
      const entry = dayBack(3);

      const { body } = await enter(member, {
        ...entry,
        breaks: [
          { startedAt: at(entry.businessDate, "12:00"), endedAt: at(entry.businessDate, "12:30") },
          { startedAt: at(entry.businessDate, "12:15"), endedAt: at(entry.businessDate, "12:45") },
        ],
      }).expect(409);

      expect(body.errors[0].context).toMatchObject({
        reason: "BREAK_OVERLAPS",
        startedAt: at(entry.businessDate, "12:00"),
        endedAt: at(entry.businessDate, "12:30"),
      });
      // The break it ran into rolled back with the entry, so there is no id to name.
      expect(body.errors[0].context).not.toHaveProperty("breakId");
      expect(await sessionsOf(member)).toHaveLength(0);
    });
  });

  describe("the timeline", () => {
    it("records exactly one SESSION_CREATED naming the admin who entered it", async () => {
      const entry = dayBack(3);
      const { body } = await enter(owner, { userId: member.id, ...entry }).expect(201);

      const written = await eventRows(body.id as string);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        eventType: "SESSION_CREATED",
        changedByUserId: owner.id,
        before: null,
      });
      expect(written[0]!.after).toMatchObject({
        businessDate: entry.businessDate,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        origin: "ENTERED",
      });

      const timeline = await request(app)
        .get(`/api/attendance/sessions/${body.id}/events`)
        .set("Cookie", cookieOf(member))
        .expect(200);
      expect(timeline.body.events).toHaveLength(1);
      expect(timeline.body.events[0]).toMatchObject({
        eventType: "SESSION_CREATED",
        user: { id: owner.id, name: owner.name },
      });
    });

    it("names the employee when they entered it themselves", async () => {
      const { body } = await enter(member, dayBack(2)).expect(201);

      const written = await eventRows(body.id as string);
      expect(written.map((event) => [event.eventType, event.changedByUserId])).toEqual([
        ["SESSION_CREATED", member.id],
      ]);
    });
  });
});
