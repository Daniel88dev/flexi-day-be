import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  attendanceBreaks,
  attendanceClosedBy,
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
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";
import { createGroup } from "../../services/group/groupServices.js";
import { createGroupUser } from "../../services/groupUser/groupUserServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { businessDateInZone } from "../../utils/dateFunc.js";

const ZONE = "Europe/Prague";
const EMPLOYED_SINCE = new Date("2020-01-01T00:00:00Z");

const daysBack = (days: number) => {
  const day = new Date(`${businessDateInZone(new Date(), ZONE)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
};

/** Between 00:00 and 21:59 UTC the date in Prague is the same one. */
const at = (date: string, time: string) => `${date}T${time}:00.000Z`;

const SESSION_DATE = daysBack(3);
const ENTRY_DATE = daysBack(5);

let ORGANIZATION_ID: string;

type Person = { id: string; name: string };

describe("a group's manager in that group's attendance scope", () => {
  let server: LoopbackServer;

  /** Owns the organization and manages Engineering. */
  let owner: Person;
  /** Manages Support without administering the organization, and is a plain member of Engineering. */
  let manager: Person;
  let engineeringAdmin: Person;
  let engineer: Person;
  let supportAdmin: Person;
  let delegate: Person;

  let engineeringId: string;
  let supportId: string;

  const cookies = new Map<string, string>();
  const employmentIds = new Map<string, string>();
  const cookieOf = (person: Person) => cookies.get(person.id)!;

  const seeded = new Map<string, { sessionId: string; breakId: string }>();

  const getTeam = (viewer: Person, groupId?: string) =>
    request(server.url)
      .get("/api/attendance/team")
      .query({
        organizationId: ORGANIZATION_ID,
        from: SESSION_DATE,
        to: SESSION_DATE,
        ...(groupId ? { groupId } : {}),
      })
      .set("Cookie", cookieOf(viewer));

  const teamOf = async (viewer: Person, groupId?: string): Promise<string[]> => {
    const { body } = await getTeam(viewer, groupId).expect(200);
    return body.people.map((person: { userId: string }) => person.userId).sort();
  };

  const rosterOf = async (viewer: Person): Promise<string[]> => {
    const { body } = await request(server.url)
      .get("/api/employment/list")
      .query({ organizationId: ORGANIZATION_ID })
      .set("Cookie", cookieOf(viewer))
      .expect(200);
    return body.map((employment: { userId: string }) => employment.userId).sort();
  };

  const enter = (viewer: Person, body: { userId?: string; businessDate: string }) =>
    request(server.url)
      .post("/api/attendance/sessions")
      .set("Cookie", cookieOf(viewer))
      .send({
        organizationId: ORGANIZATION_ID,
        ...body,
        startedAt: at(body.businessDate, "07:00"),
        endedAt: at(body.businessDate, "15:00"),
      });

  const sessionRow = async (subject: Person) => {
    const [row] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, seeded.get(subject.id)!.sessionId));
    return row!;
  };

  const breaksOf = (subject: Person) =>
    db
      .select()
      .from(attendanceBreaks)
      .where(eq(attendanceBreaks.sessionId, seeded.get(subject.id)!.sessionId));

  const sessionsOf = (subject: Person) =>
    db
      .select({ id: attendanceSessions.id })
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.employmentId, employmentIds.get(subject.id)!),
          isNull(attendanceSessions.deletedAt)
        )
      );

  /** Every read of one Employment and every admin write on it, with the status each answered. */
  const everyAccessOf = async (viewer: Person, subject: Person) => {
    const { sessionId, breakId } = seeded.get(subject.id)!;
    const cookie = cookieOf(viewer);
    const api = request(server.url);

    return {
      readEmployment: (
        await api
          .get("/api/employment")
          .query({ organizationId: ORGANIZATION_ID, userId: subject.id })
          .set("Cookie", cookie)
      ).status,
      readDay: (
        await api
          .get("/api/attendance/day")
          .query({
            organizationId: ORGANIZATION_ID,
            userId: subject.id,
            businessDate: SESSION_DATE,
          })
          .set("Cookie", cookie)
      ).status,
      readEvents: (
        await api.get(`/api/attendance/sessions/${sessionId}/events`).set("Cookie", cookie)
      ).status,
      enterSession: (await enter(viewer, { userId: subject.id, businessDate: ENTRY_DATE })).status,
      correctSession: (
        await api
          .patch(`/api/attendance/sessions/${sessionId}`)
          .set("Cookie", cookie)
          .send({ endedAt: at(SESSION_DATE, "14:00") })
      ).status,
      addBreak: (
        await api
          .post(`/api/attendance/sessions/${sessionId}/breaks`)
          .set("Cookie", cookie)
          .send({ startedAt: at(SESSION_DATE, "12:00"), endedAt: at(SESSION_DATE, "12:15") })
      ).status,
      correctBreak: (
        await api
          .patch(`/api/attendance/breaks/${breakId}`)
          .set("Cookie", cookie)
          .send({ endedAt: at(SESSION_DATE, "10:20") })
      ).status,
      deleteBreak: (await api.delete(`/api/attendance/breaks/${breakId}`).set("Cookie", cookie))
        .status,
      deleteSession: (
        await api.delete(`/api/attendance/sessions/${sessionId}`).set("Cookie", cookie)
      ).status,
    };
  };

  const refusedEverywhere = {
    readEmployment: 403,
    readDay: 403,
    readEvents: 403,
    enterSession: 403,
    correctSession: 403,
    addBreak: 403,
    correctBreak: 403,
    deleteBreak: 403,
    deleteSession: 403,
  };

  const allowedEverywhere = {
    readEmployment: 200,
    readDay: 200,
    readEvents: 200,
    enterSession: 201,
    correctSession: 200,
    addBreak: 201,
    correctBreak: 200,
    deleteBreak: 200,
    deleteSession: 200,
  };

  const expectUntouched = async (subject: Person) => {
    const session = await sessionRow(subject);
    expect(session.deletedAt).toBeNull();
    expect(session.endedAt?.toISOString()).toBe(at(SESSION_DATE, "15:00"));
    const breaks = await breaksOf(subject);
    expect(breaks.map((entry) => entry.id)).toEqual([seeded.get(subject.id)!.breakId]);
    expect(breaks[0]!.endedAt?.toISOString()).toBe(at(SESSION_DATE, "10:30"));
    expect(await sessionsOf(subject)).toHaveLength(1);
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    const make = async (email: string, name: string): Promise<Person> => {
      const user = await createTestUser(email, name, "password123");
      return { id: user.id, name };
    };

    owner = await make("scope-owner@test.com", "Olivia Owner");
    manager = await make("scope-manager@test.com", "Marco Manager");
    engineeringAdmin = await make("scope-eng-admin@test.com", "Gina Groupadmin");
    engineer = await make("scope-engineer@test.com", "Milo Member");
    supportAdmin = await make("scope-support-admin@test.com", "Sam Supportadmin");
    delegate = await make("scope-delegate@test.com", "Dora Delegate");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    // What group creation writes: the group, then its manager's own row with every flag.
    const groupManagedBy = async (groupName: string, managerUserId: string) => {
      const group = await createGroup({
        id: uuidv4(),
        organizationId: ORGANIZATION_ID,
        groupName,
        managerUserId,
        mainApprovalUser: managerUserId,
      });
      await createGroupUser({
        id: uuidv4(),
        userId: managerUserId,
        groupId: group!.id,
        viewAccess: true,
        adminAccess: true,
        approverAccess: true,
        controlledUser: true,
      });
      return group!.id;
    };
    engineeringId = await groupManagedBy("Engineering", owner.id);
    supportId = await groupManagedBy("Support", manager.id);

    const memberships: [Person, string, boolean][] = [
      [engineeringAdmin, engineeringId, true],
      [engineer, engineeringId, false],
      [manager, engineeringId, false],
      [supportAdmin, supportId, true],
    ];
    for (const [person, groupId, adminAccess] of memberships) {
      await createGroupUser({
        id: uuidv4(),
        userId: person.id,
        groupId,
        viewAccess: true,
        adminAccess,
        approverAccess: false,
        controlledUser: true,
      });
    }

    await grantOrganizationAdmin({
      organizationId: ORGANIZATION_ID,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });

    for (const person of [owner, manager, engineeringAdmin, engineer, supportAdmin, delegate]) {
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

    await upsertSubscription(ORGANIZATION_ID, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(attendanceSessions);
    await db
      .update(employments)
      .set({ startedAt: EMPLOYED_SINCE, endedAt: null })
      .where(eq(employments.organizationId, ORGANIZATION_ID));
    await upsertAttendanceSettings(ORGANIZATION_ID, {
      ...ATTENDANCE_SETTINGS_DEFAULTS,
      balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
      attendanceEnabled: true,
      timezone: ZONE,
      workingDays: [1, 2, 3, 4, 5],
      holidayCountry: null,
      selfServiceEnabled: false,
      selfServiceDays: 0,
    });

    seeded.clear();
    for (const person of [owner, manager]) {
      const sessionId = uuidv4();
      const breakId = uuidv4();
      await db.insert(attendanceSessions).values({
        id: sessionId,
        employmentId: employmentIds.get(person.id)!,
        businessDate: SESSION_DATE,
        startedAt: new Date(at(SESSION_DATE, "07:00")),
        endedAt: new Date(at(SESSION_DATE, "15:00")),
        timezone: ZONE,
        closedBy: attendanceClosedBy.User,
      });
      await db.insert(attendanceBreaks).values({
        id: breakId,
        sessionId,
        startedAt: new Date(at(SESSION_DATE, "10:00")),
        endedAt: new Date(at(SESSION_DATE, "10:30")),
      });
      seeded.set(person.id, { sessionId, breakId });
    }
  });

  describe("the team dashboard and the roster", () => {
    it("leave the manager out of their own group for that group's admin", async () => {
      const engineering = [engineeringAdmin.id, engineer.id, manager.id].sort();

      expect(await teamOf(engineeringAdmin)).toEqual(engineering);
      expect(await teamOf(engineeringAdmin, engineeringId)).toEqual(engineering);
      expect(await rosterOf(engineeringAdmin)).toEqual(engineering);

      expect(await teamOf(supportAdmin)).toEqual([supportAdmin.id]);
      expect(await teamOf(supportAdmin, supportId)).toEqual([supportAdmin.id]);
      expect(await rosterOf(supportAdmin)).toEqual([supportAdmin.id]);
    });

    it("keep the manager in a group they are a plain member of", async () => {
      expect(await teamOf(engineeringAdmin)).toContain(manager.id);
      expect(await rosterOf(engineeringAdmin)).toContain(manager.id);
    });

    it("still show an org admin, a delegate included, every manager", async () => {
      for (const viewer of [owner, delegate]) {
        expect(await teamOf(viewer)).toEqual(expect.arrayContaining([owner.id, manager.id]));
        expect(await rosterOf(viewer)).toEqual(expect.arrayContaining([owner.id, manager.id]));
      }
      expect(await teamOf(owner, supportId)).toEqual([manager.id, supportAdmin.id].sort());
      expect(await teamOf(delegate, engineeringId)).toContain(owner.id);
    });
  });

  describe("one Employment", () => {
    it("refuses a group admin every read and write on their own group's manager", async () => {
      expect(await everyAccessOf(engineeringAdmin, owner)).toEqual(refusedEverywhere);
      await expectUntouched(owner);

      expect(await everyAccessOf(supportAdmin, manager)).toEqual(refusedEverywhere);
      await expectUntouched(manager);
    });

    it("lets the admin of a group the manager is a plain member of read and correct them", async () => {
      expect(await everyAccessOf(engineeringAdmin, manager)).toEqual(allowedEverywhere);
    });

    it("lets the owner read and correct a manager", async () => {
      expect(await everyAccessOf(owner, manager)).toEqual(allowedEverywhere);
    });

    it("lets a delegate org admin read and correct a manager", async () => {
      expect(await everyAccessOf(delegate, manager)).toEqual(allowedEverywhere);
    });
  });

  describe("a manager's own attendance", () => {
    const currentOf = async (viewer: Person) =>
      (
        await request(server.url)
          .get("/api/attendance/current")
          .query({ organizationId: ORGANIZATION_ID })
          .set("Cookie", cookieOf(viewer))
          .expect(200)
      ).body;

    it("is not administered through the group they manage", async () => {
      expect((await currentOf(manager)).administersOwnAttendance).toBe(false);
      expect((await currentOf(owner)).administersOwnAttendance).toBe(true);
      expect((await currentOf(supportAdmin)).administersOwnAttendance).toBe(true);
    });

    it("follows the self-service window like anyone's", async () => {
      const { body } = await enter(manager, { businessDate: ENTRY_DATE }).expect(403);

      expect(body.errors[0].context.reason).toBe("SELF_SERVICE_OFF");
      expect(await sessionsOf(manager)).toHaveLength(1);

      await db
        .update(organizationAttendanceSettings)
        .set({ selfServiceEnabled: true, selfServiceDays: 7 })
        .where(eq(organizationAttendanceSettings.organizationId, ORGANIZATION_ID));

      const outside = await enter(manager, { businessDate: daysBack(10) }).expect(403);
      expect(outside.body.errors[0].context.reason).toBe("SELF_SERVICE_WINDOW");

      const inside = await enter(manager, { businessDate: ENTRY_DATE }).expect(201);
      expect(inside.body.enteredByUserId).toBe(manager.id);
      expect(await sessionsOf(manager)).toHaveLength(2);
    });
  });
});
