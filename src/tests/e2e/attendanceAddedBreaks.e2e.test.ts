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

describe("breaks added to closed attendance sessions", () => {
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

  const breaksOf = (sessionId: string) =>
    db
      .select()
      .from(attendanceBreaks)
      .where(eq(attendanceBreaks.sessionId, sessionId))
      .orderBy(asc(attendanceBreaks.startedAt));

  const workedOn = async (person: Person, businessDate: string): Promise<number> => {
    const team = await request(app)
      .get("/api/attendance/team")
      .query({ organizationId: ORGANIZATION_ID, from: businessDate, to: businessDate })
      .set("Cookie", cookieOf(owner))
      .expect(200);
    return team.body.people.find((row: { userId: string }) => row.userId === person.id).days[0]
      .workedMinutes as number;
  };

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

    owner = await make("break-owner@test.com", "Olivia Owner");
    groupAdmin = await make("break-admin@test.com", "Gina Groupadmin");
    member = await make("break-member@test.com", "Milo Member");
    salesAdmin = await make("break-sales@test.com", "Sam Salesadmin");

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

  describe("an admin", () => {
    it("adds a break to a member's clocked session from last month, recorded as theirs", async () => {
      const session = await clocked(member, 35);
      const lunch = {
        startedAt: at(session.businessDate, "11:00"),
        endedAt: at(session.businessDate, "11:50"),
      };

      const { body } = await addBreak(owner, session.id, lunch).expect(201);

      expect(body).toMatchObject({
        id: session.id,
        origin: "CLOCKED",
        breaks: [{ ...lunch, open: false, autoClosed: false }],
      });

      const written = await eventRows(session.id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        eventType: "BREAK_ADDED",
        changedByUserId: owner.id,
        before: null,
        after: { breakId: body.breaks[0].id, ...lunch },
      });
    });

    it("counts the break into the day, once it is longer than the allowance", async () => {
      const session = await clocked(member, 35);
      // Eight hours of presence: past the six-hour threshold, so 30 minutes
      // come off whether or not a break was taken.
      expect(await workedOn(member, session.businessDate)).toBe(450);

      await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "11:00"),
        endedAt: at(session.businessDate, "11:50"),
      }).expect(201);

      expect(await workedOn(member, session.businessDate)).toBe(430);
    });

    it("adds one to a session that was entered, as to a clocked one", async () => {
      const session = await clocked(member, 35, { entered: true });

      await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "12:00"),
        endedAt: at(session.businessDate, "12:30"),
      }).expect(201);

      expect(await breaksOf(session.id)).toHaveLength(1);
    });

    it("refuses a group admin of another group", async () => {
      const session = await clocked(member, 3);

      await addBreak(salesAdmin, session.id, {
        startedAt: at(session.businessDate, "12:00"),
        endedAt: at(session.businessDate, "12:30"),
      }).expect(403);

      expect(await breaksOf(session.id)).toHaveLength(0);
    });

    it("refuses once the plan has lapsed", async () => {
      const session = await clocked(member, 3);
      await upsertSubscription(ORGANIZATION_ID, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() - DAY_MS),
      });

      const { body } = await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "12:00"),
        endedAt: at(session.businessDate, "12:30"),
      }).expect(402);

      expect(body.errors[0].context.reason).toBe("PLAN_LIMIT");
      expect(await breaksOf(session.id)).toHaveLength(0);
    });
  });

  describe("the employee", () => {
    const lunchOn = (businessDate: string) => ({
      startedAt: at(businessDate, "12:00"),
      endedAt: at(businessDate, "12:30"),
    });

    it("adds one to their own session inside the window", async () => {
      const session = await clocked(member, 7);

      await addBreak(member, session.id, lunchOn(session.businessDate)).expect(201);

      expect(
        (await eventRows(session.id)).map((event) => [event.eventType, event.changedByUserId])
      ).toEqual([["BREAK_ADDED", member.id]]);
    });

    it("is refused a session outside the window", async () => {
      const session = await clocked(member, 8);

      const { body } = await addBreak(member, session.id, lunchOn(session.businessDate)).expect(
        403
      );

      expect(body.errors[0].context.reason).toBe("SELF_SERVICE_WINDOW");
      expect(await breaksOf(session.id)).toHaveLength(0);
    });

    it("is refused with the window off, and told corrections go through an admin", async () => {
      const session = await clocked(member, 1);
      await setWindow(false, 0);

      const { body } = await addBreak(member, session.id, lunchOn(session.businessDate)).expect(
        403
      );

      expect(body.errors[0].context.reason).toBe("SELF_SERVICE_OFF");
      expect(body.errors[0].message).toBe(
        "Your organization manages attendance corrections through an admin. Ask a group admin, or an organization admin."
      );
      expect(await breaksOf(session.id)).toHaveLength(0);
    });
  });

  describe("what an added break has to be", () => {
    it("refuses a session that is still open", async () => {
      const session = await clocked(member, 0, { open: true });

      const { body } = await addBreak(owner, session.id, {
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        endedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      }).expect(409);

      expect(body.errors[0].context.reason).toBe("SESSION_STILL_OPEN");
      expect(await breaksOf(session.id)).toHaveLength(0);
    });

    it("refuses a break reaching outside its session", async () => {
      const session = await clocked(member, 3);

      const { body } = await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "14:50"),
        endedAt: at(session.businessDate, "15:20"),
      }).expect(422);

      expect(body.errors[0].context.reason).toBe("BREAK_OUTSIDE_SESSION");
      expect(await breaksOf(session.id)).toHaveLength(0);
    });

    it("refuses a break that ends before it starts", async () => {
      const session = await clocked(member, 3);

      const { body } = await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "12:30"),
        endedAt: at(session.businessDate, "12:00"),
      }).expect(422);

      expect(body.errors[0].context.reason).toBe("END_BEFORE_START");
    });

    it("refuses a break over another one, naming it, and allows one back to back", async () => {
      const session = await clocked(member, 3);
      const first = await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "12:00"),
        endedAt: at(session.businessDate, "12:30"),
      }).expect(201);

      const { body } = await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "12:20"),
        endedAt: at(session.businessDate, "12:45"),
      }).expect(409);

      expect(body.errors[0].context).toMatchObject({
        reason: "BREAK_OVERLAPS",
        breakId: first.body.breaks[0].id,
        startedAt: at(session.businessDate, "12:00"),
        endedAt: at(session.businessDate, "12:30"),
      });

      await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "12:30"),
        endedAt: at(session.businessDate, "12:45"),
      }).expect(201);
      expect(await breaksOf(session.id)).toHaveLength(2);
    });

    it("holds a corrected break to the same rule", async () => {
      const session = await clocked(member, 3);
      await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "12:00"),
        endedAt: at(session.businessDate, "12:30"),
      }).expect(201);
      const added = await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "14:00"),
        endedAt: at(session.businessDate, "14:15"),
      }).expect(201);
      const later = added.body.breaks.find(
        (entry: { startedAt: string }) => entry.startedAt === at(session.businessDate, "14:00")
      );

      const { body } = await request(app)
        .patch(`/api/attendance/breaks/${later.id}`)
        .set("Cookie", cookieOf(owner))
        .send({ startedAt: at(session.businessDate, "12:15") })
        .expect(409);

      expect(body.errors[0].context.reason).toBe("BREAK_OVERLAPS");
    });

    it("refuses a break that swallows another one whole", async () => {
      const session = await clocked(member, 3);
      await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "12:00"),
        endedAt: at(session.businessDate, "12:30"),
      }).expect(201);

      await addBreak(owner, session.id, {
        startedAt: at(session.businessDate, "11:30"),
        endedAt: at(session.businessDate, "13:00"),
      }).expect(409);
    });
  });
});
