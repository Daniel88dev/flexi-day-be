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

const daysBefore = (date: string, days: number) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
};

/**
 * A UTC instant on a date. Between 00:00 and 21:59 UTC the date in Prague is
 * the same one, which is all the sessions below rely on.
 */
const at = (date: string, time: string) => `${date}T${time}:00.000Z`;

let ORGANIZATION_ID: string;

type Person = { id: string; name: string };

describe("attendance sessions changed after the day", () => {
  let app: Express;

  let owner: Person;
  let groupAdmin: Person;
  let member: Person;
  let salesAdmin: Person;

  const cookies = new Map<string, string>();
  const employmentIds = new Map<string, string>();

  const cookieOf = (person: Person) => cookies.get(person.id)!;

  const addBreak = (
    person: Person,
    sessionId: string,
    body: { startedAt: string; endedAt: string }
  ) =>
    request(app)
      .post(`/api/attendance/sessions/${sessionId}/breaks`)
      .set("Cookie", cookieOf(person))
      .send(body);

  /** A clocked session from 07:00 to 15:00 UTC, some whole days back. */
  const clocked = async (
    person: Person,
    daysBack: number,
    options: { open?: boolean; entered?: boolean } = {}
  ) => {
    const businessDate = daysBefore(today(), daysBack);
    const id = uuidv4();
    await db.insert(attendanceSessions).values({
      id,
      employmentId: employmentIds.get(person.id)!,
      businessDate,
      startedAt: new Date(at(businessDate, "07:00")),
      endedAt: options.open ? null : new Date(at(businessDate, "15:00")),
      timezone: ZONE,
      closedBy: options.open ? null : "USER",
      origin: options.entered ? "ENTERED" : "CLOCKED",
    });
    return { id, businessDate };
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

  const patchSession = (person: Person, sessionId: string, body: object) =>
    request(app)
      .patch(`/api/attendance/sessions/${sessionId}`)
      .set("Cookie", cookieOf(person))
      .send(body);

  const sessionOnDay = async (person: Person, businessDate: string, sessionId: string) => {
    const { body } = await request(app)
      .get("/api/attendance/day")
      .query({ organizationId: ORGANIZATION_ID, businessDate, userId: person.id })
      .set("Cookie", cookieOf(owner))
      .expect(200);
    return body.sessions.find((entry: { id: string }) => entry.id === sessionId);
  };

  const teamDay = async (person: Person, businessDate: string) => {
    const { body } = await request(app)
      .get("/api/attendance/team")
      .query({ organizationId: ORGANIZATION_ID, from: businessDate, to: businessDate })
      .set("Cookie", cookieOf(owner))
      .expect(200);
    return body.people.find((row: { userId: string }) => row.userId === person.id).days[0];
  };

  const lunchOn = (businessDate: string) => ({
    startedAt: at(businessDate, "12:00"),
    endedAt: at(businessDate, "12:30"),
  });

  /** A lunch break added by someone, which is how a session gets one to move. */
  const breakBy = async (person: Person, session: { id: string; businessDate: string }) => {
    const { body } = await addBreak(person, session.id, lunchOn(session.businessDate)).expect(201);
    return body.breaks[0].id as string;
  };

  const flagged = async () => {
    const session = await clocked(member, 2);
    await patchSession(member, session.id, { endedAt: at(session.businessDate, "16:00") }).expect(
      200
    );
    return session;
  };

  const isChanged = async (person: Person, session: { id: string; businessDate: string }) =>
    (await sessionOnDay(person, session.businessDate, session.id)).changedAfterDay as boolean;

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

    owner = await make("changed-owner@test.com", "Olivia Owner");
    groupAdmin = await make("changed-admin@test.com", "Gina Groupadmin");
    member = await make("changed-member@test.com", "Milo Member");
    salesAdmin = await make("changed-sales@test.com", "Sam Salesadmin");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    const groupOf = async (groupName: string) => {
      const id = uuidv4();
      await db.insert(groups).values({
        id,
        organizationId: ORGANIZATION_ID,
        groupName,
        managerUserId: owner.id,
        mainApprovalUser: owner.id,
      });
      return id;
    };
    const engineeringId = await groupOf("Engineering");
    const salesId = await groupOf("Sales");

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

  describe("a self-service write to a past day", () => {
    it("flags the session when the employee corrects it", async () => {
      const session = await clocked(member, 2);

      await patchSession(member, session.id, { endedAt: at(session.businessDate, "16:00") }).expect(
        200
      );

      expect(await isChanged(member, session)).toBe(true);
    });

    it("flags the session when the employee adds a break to it", async () => {
      const session = await clocked(member, 2);

      await addBreak(member, session.id, lunchOn(session.businessDate)).expect(201);

      expect(await isChanged(member, session)).toBe(true);
    });

    it("flags the session when the employee moves one of its breaks", async () => {
      const session = await clocked(member, 2);
      const breakId = await breakBy(owner, session);

      await request(app)
        .patch(`/api/attendance/breaks/${breakId}`)
        .set("Cookie", cookieOf(member))
        .send({ endedAt: at(session.businessDate, "12:45") })
        .expect(200);

      expect(await isChanged(member, session)).toBe(true);
    });

    it("flags the session when the employee deletes one of its breaks", async () => {
      const session = await clocked(member, 2);
      const breakId = await breakBy(owner, session);

      await request(app)
        .delete(`/api/attendance/breaks/${breakId}`)
        .set("Cookie", cookieOf(member))
        .expect(200);

      expect(await isChanged(member, session)).toBe(true);
    });
  });

  describe("a write that leaves the session unflagged", () => {
    it("is any self-service write to a session dated today", async () => {
      const session = await clocked(member, 0);

      await patchSession(member, session.id, {
        startedAt: at(session.businessDate, "06:30"),
      }).expect(200);
      const breakId = await breakBy(member, session);
      await request(app)
        .patch(`/api/attendance/breaks/${breakId}`)
        .set("Cookie", cookieOf(member))
        .send({ endedAt: at(session.businessDate, "12:45") })
        .expect(200);
      await request(app)
        .delete(`/api/attendance/breaks/${breakId}`)
        .set("Cookie", cookieOf(member))
        .expect(200);

      expect(await isChanged(member, session)).toBe(false);
    });

    it("is any admin write to a past day, the admin's own session included", async () => {
      const members = await clocked(member, 2);
      const own = await clocked(owner, 2);

      for (const session of [members, own]) {
        await patchSession(owner, session.id, {
          endedAt: at(session.businessDate, "16:00"),
        }).expect(200);
        const breakId = await breakBy(owner, session);
        await request(app)
          .delete(`/api/attendance/breaks/${breakId}`)
          .set("Cookie", cookieOf(owner))
          .expect(200);
      }

      expect(await isChanged(member, members)).toBe(false);
      expect(await isChanged(owner, own)).toBe(false);
    });

    it("is the employee entering a past day, which carries the entered marker instead", async () => {
      const businessDate = daysBefore(today(), 2);

      const { body } = await request(app)
        .post("/api/attendance/sessions")
        .set("Cookie", cookieOf(member))
        .send({
          organizationId: ORGANIZATION_ID,
          businessDate,
          startedAt: at(businessDate, "07:00"),
          endedAt: at(businessDate, "15:00"),
          breaks: [lunchOn(businessDate)],
        })
        .expect(201);

      expect(body).toMatchObject({ origin: "ENTERED", changedAfterDay: false });
      expect(await teamDay(member, businessDate)).toMatchObject({
        entered: true,
        changedAfterDay: false,
        flagged: false,
      });
    });
  });

  it("leaves a session unflagged when the employee's write is refused", async () => {
    const session = await clocked(member, 2);
    await setWindow(false, 0);

    await patchSession(member, session.id, { endedAt: at(session.businessDate, "16:00") }).expect(
      403
    );

    expect(await isChanged(member, session)).toBe(false);
  });

  it("flags an entered session its owner corrects after its day", async () => {
    const session = await clocked(member, 2, { entered: true });

    await patchSession(member, session.id, { endedAt: at(session.businessDate, "16:00") }).expect(
      200
    );

    expect(await isChanged(member, session)).toBe(true);
  });

  describe("a flagged session", () => {
    it("flags its day on the team read, as its own field beside the others", async () => {
      const session = await flagged();

      expect(await teamDay(member, session.businessDate)).toMatchObject({
        changedAfterDay: true,
        autoClosed: false,
        excludedClockIn: false,
        entered: false,
        flagged: true,
      });
    });

    it("flags its day on the owner's month", async () => {
      const session = await flagged();
      const [year, month] = session.businessDate.split("-").map(Number);

      const { body } = await request(app)
        .get("/api/attendance/month")
        .query({ organizationId: ORGANIZATION_ID, year, month })
        .set("Cookie", cookieOf(member))
        .expect(200);

      const day = body.days.find(
        (entry: { businessDate: string }) => entry.businessDate === session.businessDate
      );
      expect(day).toMatchObject({ changedAfterDay: true, flagged: true });
      expect(day.sessions).toMatchObject([{ id: session.id, changedAfterDay: true }]);
    });

    it("stays flagged when its owner changes it again", async () => {
      const session = await flagged();

      await patchSession(member, session.id, { endedAt: at(session.businessDate, "15:30") }).expect(
        200
      );

      expect(await isChanged(member, session)).toBe(true);
    });

    it("is cleared by an admin correcting the session", async () => {
      const session = await flagged();

      await patchSession(owner, session.id, { endedAt: at(session.businessDate, "15:30") }).expect(
        200
      );

      expect(await isChanged(member, session)).toBe(false);
      expect(await teamDay(member, session.businessDate)).toMatchObject({
        changedAfterDay: false,
        flagged: false,
      });
    });

    it("is cleared by a group admin editing one of its breaks", async () => {
      const session = await flagged();
      const breakId = await breakBy(member, session);

      await request(app)
        .patch(`/api/attendance/breaks/${breakId}`)
        .set("Cookie", cookieOf(groupAdmin))
        .send({ endedAt: at(session.businessDate, "12:45") })
        .expect(200);

      expect(await isChanged(member, session)).toBe(false);
    });
  });

  describe("marking a session as checked", () => {
    const markChecked = (person: Person, sessionId: string) =>
      request(app)
        .post(`/api/attendance/sessions/${sessionId}/check`)
        .set("Cookie", cookieOf(person));

    const checkedEvents = async (sessionId: string) =>
      (await eventRows(sessionId)).filter((event) => event.eventType === "SESSION_CHECKED");

    it("clears the flag without moving a time, with exactly one event naming the admin", async () => {
      const session = await flagged();

      const { body } = await markChecked(owner, session.id).expect(200);

      expect(body).toMatchObject({
        id: session.id,
        changedAfterDay: false,
        startedAt: at(session.businessDate, "07:00"),
        endedAt: at(session.businessDate, "16:00"),
      });
      expect(await isChanged(member, session)).toBe(false);
      expect(await teamDay(member, session.businessDate)).toMatchObject({ flagged: false });
      expect(await checkedEvents(session.id)).toEqual([
        {
          eventType: "SESSION_CHECKED",
          changedByUserId: owner.id,
          before: { changedAfterDay: true },
          after: { changedAfterDay: false },
        },
      ]);
    });

    it("lets a group admin of the member's group do it", async () => {
      const session = await flagged();

      await markChecked(groupAdmin, session.id).expect(200);

      expect(await isChanged(member, session)).toBe(false);
    });

    it("refuses the employee, inside their window, and leaves the flag", async () => {
      const session = await flagged();

      const { body } = await markChecked(member, session.id).expect(403);

      expect(body.errors[0].context.reason).toBe("ADMIN_ONLY");
      expect(await isChanged(member, session)).toBe(true);
      expect(await checkedEvents(session.id)).toHaveLength(0);
    });

    it("refuses a group admin of another group", async () => {
      const session = await flagged();

      await markChecked(salesAdmin, session.id).expect(403);

      expect(await isChanged(member, session)).toBe(true);
    });

    it("refuses a session that is not flagged, writing nothing", async () => {
      const session = await clocked(member, 2);

      const { body } = await markChecked(owner, session.id).expect(409);

      expect(body.errors[0].context.reason).toBe("SESSION_NOT_CHANGED");
      expect(await eventRows(session.id)).toHaveLength(0);
    });

    it("refuses once the plan has lapsed", async () => {
      const session = await flagged();
      await upsertSubscription(ORGANIZATION_ID, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() - DAY_MS),
      });

      const { body } = await markChecked(owner, session.id).expect(402);

      expect(body.errors[0].context.reason).toBe("PLAN_LIMIT");
      expect(await isChanged(member, session)).toBe(true);
    });

    it("answers 404 for a deleted session", async () => {
      const session = await flagged();
      await request(app)
        .delete(`/api/attendance/sessions/${session.id}`)
        .set("Cookie", cookieOf(owner))
        .expect(200);

      await markChecked(owner, session.id).expect(404);
    });
  });

  describe("the caller's standing over their own attendance", () => {
    const standing = async (person: Person) => {
      const { body } = await request(app)
        .get("/api/attendance/current")
        .query({ organizationId: ORGANIZATION_ID })
        .set("Cookie", cookieOf(person))
        .expect(200);
      return body.administersOwnAttendance as boolean;
    };

    it("is reported on the state read, so the web knows whose self-edits get flagged", async () => {
      expect(await standing(owner)).toBe(true);
      expect(await standing(groupAdmin)).toBe(true);
      expect(await standing(member)).toBe(false);
    });

    it("means a group admin's own past-day correction is never flagged", async () => {
      const session = await clocked(groupAdmin, 2);

      await patchSession(groupAdmin, session.id, {
        endedAt: at(session.businessDate, "16:00"),
      }).expect(200);

      expect(await isChanged(groupAdmin, session)).toBe(false);
    });
  });
});
