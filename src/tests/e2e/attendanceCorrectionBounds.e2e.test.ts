import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
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
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { businessDateInZone } from "../../utils/dateFunc.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ZONE = "Europe/Prague";
/** Wednesday 16 September 2026, 13:00 in Prague: every fixture below is placed from it. */
const NOW = new Date("2026-09-16T11:00:00Z");
const EMPLOYED_SINCE = new Date(NOW.getTime() - 30 * DAY_MS);

const today = () => businessDateInZone(new Date(), ZONE);

const daysBefore = (date: string, days: number) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
};

/** An instant on a date given as UTC hours; 02:00–21:00 UTC always falls on that date in Prague. */
const at = (date: string, utcHour: number) =>
  new Date(`${date}T${String(utcHour).padStart(2, "0")}:00:00Z`);

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * MINUTE_MS);

type Person = { id: string; name: string };

describe("attendance correction bounds", () => {
  let server: LoopbackServer;
  let organizationId: string;
  let owner: Person;
  let member: Person;
  let memberEmploymentId: string;
  let memberCookie: string;
  let ownerCookie: string;

  const patchSession = (sessionId: string, body: unknown, cookie = memberCookie) =>
    request(server.url)
      .patch(`/api/attendance/sessions/${sessionId}`)
      .set("Cookie", cookie)
      .send(body);

  const patchBreak = (breakId: string, body: unknown) =>
    request(server.url)
      .patch(`/api/attendance/breaks/${breakId}`)
      .set("Cookie", memberCookie)
      .send(body);

  const seedSession = async (input: {
    businessDate: string;
    startedAt: Date;
    endedAt: Date | null;
    closedBy?: attendanceClosedBy;
    breaks?: { startedAt: Date; endedAt: Date | null }[];
  }) => {
    const id = uuidv4();
    await db.insert(attendanceSessions).values({
      id,
      employmentId: memberEmploymentId,
      businessDate: input.businessDate,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      timezone: ZONE,
      closedBy: input.closedBy ?? (input.endedAt ? attendanceClosedBy.User : null),
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
        autoClosed: false,
      });
    }

    return { id, breakIds };
  };

  const sessionRow = async (sessionId: string) => {
    const [row] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, sessionId));
    return row!;
  };

  const breakRow = async (breakId: string) => {
    const [row] = await db.select().from(attendanceBreaks).where(eq(attendanceBreaks.id, breakId));
    return row!;
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    const ownerUser = await createTestUser("bounds-owner@test.com", "Bea Owner", "password123");
    const memberUser = await createTestUser("bounds-member@test.com", "Xena Member", "password123");
    owner = { id: ownerUser.id, name: "Bea Owner" };
    member = { id: memberUser.id, name: "Xena Member" };

    organizationId = (await ensureOrganizationForUser(owner.id)).id;

    const groupId = uuidv4();
    await db.insert(groups).values({
      id: groupId,
      organizationId,
      groupName: "Engineering",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });
    await db.insert(groupUsers).values({
      id: uuidv4(),
      userId: member.id,
      groupId,
      viewAccess: true,
      adminAccess: false,
      approverAccess: false,
      controlledUser: true,
    });

    await syncEmployment(organizationId, member.id);
    memberCookie = await authCookieFor(member.id);
    ownerCookie = await authCookieFor(owner.id);
    const [row] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(
        and(eq(employments.organizationId, organizationId), eq(employments.userId, member.id))
      );
    memberEmploymentId = row!.id;
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  beforeEach(async () => {
    // Only `Date` is faked: the pg driver's own timers have to keep running.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    await db.delete(attendanceSessions);
    await db
      .update(employments)
      .set({ startedAt: EMPLOYED_SINCE, endedAt: null })
      .where(eq(employments.id, memberEmploymentId));
    await db.delete(organizationAttendanceSettings);
    await upsertAttendanceSettings(organizationId, {
      ...ATTENDANCE_SETTINGS_DEFAULTS,
      balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
      attendanceEnabled: true,
      timezone: ZONE,
      selfServiceEnabled: true,
      selfServiceDays: 3,
    });
    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const expectUnchanged = async (sessionId: string, startedAt: Date, endedAt: Date | null) => {
    const row = await sessionRow(sessionId);
    expect(row.startedAt.toISOString()).toBe(startedAt.toISOString());
    expect(row.endedAt?.toISOString() ?? null).toBe(endedAt?.toISOString() ?? null);
  };

  describe("an employee correcting their own session", () => {
    it("refuses moving a session's times onto another day", async () => {
      const date = daysBefore(today(), 1);
      const target = daysBefore(today(), 3);
      const { id } = await seedSession({
        businessDate: date,
        startedAt: at(date, 8),
        endedAt: at(date, 9),
      });

      const { body } = await patchSession(id, {
        startedAt: at(target, 6).toISOString(),
        endedAt: at(target, 14).toISOString(),
      }).expect(422);
      expect(body.errors[0].context.reason).toBe("START_OFF_DATE");

      const row = await sessionRow(id);
      expect(row.startedAt.toISOString()).toBe(at(date, 8).toISOString());
    });

    it("refuses moving a session onto a day before the employment began", async () => {
      const date = today();
      await db
        .update(employments)
        .set({ startedAt: new Date(`${date}T00:00:00Z`) })
        .where(eq(employments.id, memberEmploymentId));
      const start = minutesFromNow(-10);
      const end = minutesFromNow(-5);
      const { id } = await seedSession({
        businessDate: businessDateInZone(start, ZONE),
        startedAt: start,
        endedAt: end,
      });

      const target = daysBefore(today(), 3);
      const { body } = await patchSession(id, {
        startedAt: at(target, 6).toISOString(),
        endedAt: at(target, 14).toISOString(),
      }).expect(422);
      expect(body.errors[0].context.reason).toBe("START_OFF_DATE");
      await expectUnchanged(id, start, end);
    });

    it("refuses a session longer than the organization's ceiling", async () => {
      const date = daysBefore(today(), 2);
      const { id } = await seedSession({
        businessDate: date,
        startedAt: at(date, 8),
        endedAt: at(date, 9),
      });

      const ceilingMinutes = ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes;
      const start = at(date, 2);
      const { body } = await patchSession(id, {
        startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + (ceilingMinutes + 60) * MINUTE_MS).toISOString(),
      }).expect(422);
      expect(body.errors[0].context.reason).toBe("OVER_CEILING");
      await expectUnchanged(id, at(date, 8), at(date, 9));
    });

    it("judges a clock-out alone on the whole span it leaves", async () => {
      const date = daysBefore(today(), 2);
      const { id } = await seedSession({
        businessDate: date,
        startedAt: at(date, 2),
        endedAt: at(date, 9),
      });

      const ceilingMinutes = ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes;
      const { body } = await patchSession(id, {
        endedAt: new Date(at(date, 2).getTime() + (ceilingMinutes + 1) * MINUTE_MS).toISOString(),
      }).expect(422);
      expect(body.errors[0].context).toMatchObject({ reason: "OVER_CEILING", ceilingMinutes });
      await expectUnchanged(id, at(date, 2), at(date, 9));
    });

    it("still corrects a session the sweep closed at exactly the ceiling", async () => {
      const date = daysBefore(today(), 1);
      const ceiling = ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes * MINUTE_MS;
      const { id } = await seedSession({
        businessDate: date,
        startedAt: at(date, 3),
        endedAt: new Date(at(date, 3).getTime() + ceiling),
        closedBy: attendanceClosedBy.Sweep,
      });

      const { body } = await patchSession(id, {
        startedAt: at(date, 2).toISOString(),
        endedAt: new Date(at(date, 2).getTime() + ceiling).toISOString(),
      }).expect(200);
      expect(body.closedBy).toBe("USER");
    });

    it("takes a correction on the session's own day, in the past and under the ceiling", async () => {
      const date = daysBefore(today(), 1);
      const { id } = await seedSession({
        businessDate: date,
        startedAt: at(date, 8),
        endedAt: at(date, 9),
      });

      await patchSession(id, {
        startedAt: at(date, 6).toISOString(),
        endedAt: at(date, 14).toISOString(),
      }).expect(200);
    });

    it("refuses a clock-out after now", async () => {
      const start = minutesFromNow(-10);
      const { id } = await seedSession({
        businessDate: businessDateInZone(start, ZONE),
        startedAt: start,
        endedAt: minutesFromNow(-5),
      });

      const { body } = await patchSession(id, {
        endedAt: minutesFromNow(120).toISOString(),
      }).expect(422);
      expect(body.errors[0].context.reason).toBe("END_IN_FUTURE");

      expect((await sessionRow(id)).endedAt!.getTime()).toBeLessThan(Date.now());
    });

    it("refuses moving an open session's clock-in onto another day", async () => {
      const start = minutesFromNow(-30);
      const { id } = await seedSession({
        businessDate: businessDateInZone(start, ZONE),
        startedAt: start,
        endedAt: null,
      });

      const target = daysBefore(today(), 2);
      const { body } = await patchSession(id, {
        startedAt: at(target, 8).toISOString(),
      }).expect(422);
      expect(body.errors[0].context.reason).toBe("START_OFF_DATE");
      await expectUnchanged(id, start, null);
    });

    it("refuses moving an open session's clock-in past now", async () => {
      const start = minutesFromNow(-30);
      const { id } = await seedSession({
        businessDate: businessDateInZone(start, ZONE),
        startedAt: start,
        endedAt: null,
      });

      const { body } = await patchSession(id, {
        startedAt: minutesFromNow(60).toISOString(),
      }).expect(422);
      expect(body.errors[0].context.reason).toBe("START_IN_FUTURE");
      await expectUnchanged(id, start, null);
    });
  });

  describe("an admin correcting somebody's session", () => {
    it("is held to now as well", async () => {
      const start = minutesFromNow(-10);
      const end = minutesFromNow(-5);
      const { id } = await seedSession({
        businessDate: businessDateInZone(start, ZONE),
        startedAt: start,
        endedAt: end,
      });

      const { body } = await patchSession(
        id,
        { endedAt: minutesFromNow(120).toISOString() },
        ownerCookie
      ).expect(422);
      expect(body.errors[0].context.reason).toBe("END_IN_FUTURE");
      await expectUnchanged(id, start, end);
    });
  });

  describe("an employee correcting a break", () => {
    it("refuses an open break's start after now", async () => {
      const start = minutesFromNow(-30);
      const { breakIds } = await seedSession({
        businessDate: businessDateInZone(start, ZONE),
        startedAt: start,
        endedAt: null,
        breaks: [{ startedAt: minutesFromNow(-10), endedAt: null }],
      });

      const { body } = await patchBreak(breakIds[0]!, {
        startedAt: minutesFromNow(30).toISOString(),
      }).expect(422);
      expect(body.errors[0].context.reason).toBe("START_IN_FUTURE");
      expect((await breakRow(breakIds[0]!)).startedAt.getTime()).toBeLessThan(Date.now());
    });

    it("refuses a break end after now on a session still open", async () => {
      const start = minutesFromNow(-30);
      const { breakIds } = await seedSession({
        businessDate: businessDateInZone(start, ZONE),
        startedAt: start,
        endedAt: null,
        breaks: [{ startedAt: minutesFromNow(-20), endedAt: minutesFromNow(-10) }],
      });

      const { body } = await patchBreak(breakIds[0]!, {
        endedAt: minutesFromNow(60).toISOString(),
      }).expect(422);
      expect(body.errors[0].context.reason).toBe("END_IN_FUTURE");

      expect((await breakRow(breakIds[0]!)).endedAt!.getTime()).toBeLessThan(Date.now());
    });
  });
});
