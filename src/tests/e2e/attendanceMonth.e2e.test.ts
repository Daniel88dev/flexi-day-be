import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { attendanceBreaks, attendanceSessions } from "../../db/schema/attendance-schema.js";
import { bankHolidays } from "../../db/schema/bank-holiday-schema.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { CalendarRecordType, vacation } from "../../db/schema/vacation-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { monthEnd } from "../../utils/dateFunc.js";

const ZONE = "Europe/Prague";

/**
 * The month before the one the suite runs in, so every day of it has already
 * happened however late this is run — `upcoming` days are excluded from the
 * balance, and a month still in progress would move under the assertions.
 */
const previousMonth = () => {
  const now = new Date();
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 };
};

const { year, month } = previousMonth();
const DAYS_IN_MONTH = Number(monthEnd(year, month).slice(8));
const businessDate = (day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
/** An instant on a day of the seeded month, given in UTC — the business date is set by hand. */
const at = (day: number, time: string) => new Date(`${businessDate(day)}T${time}:00Z`);

let ORGANIZATION_ID: string;

/** Long enough before the seeded month that no date in it predates the spell. */
const EMPLOYED_SINCE = new Date("2020-01-01T00:00:00Z");

/**
 * The organization keeps a seven-day week unless a test says otherwise, so the
 * figures below stay about worked time rather than about which month the suite
 * happens to run in. Excluded days have their own block, with the ordinary
 * Monday-to-Friday week and a calendar pinned by hand.
 */
const settings = (
  overrides: {
    balanceMode?: balanceMode;
    workingDays?: number[];
    holidayCountry?: string | null;
  } = {}
) =>
  upsertAttendanceSettings(ORGANIZATION_ID, {
    ...ATTENDANCE_SETTINGS_DEFAULTS,
    balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
    attendanceEnabled: true,
    timezone: ZONE,
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    ...overrides,
  });

const proActive = () =>
  upsertSubscription(ORGANIZATION_ID, {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });

describe("my attendance, by month", () => {
  let app: Express;

  let owner: { id: string };
  let groupAdmin: { id: string };
  let member: { id: string };
  let colleague: { id: string };

  let ownerCookie: string;
  let groupAdminCookie: string;
  let memberCookie: string;
  let colleagueCookie: string;

  let memberEmploymentId: string;
  let colleagueEmploymentId: string;
  let engineeringGroupId: string;

  const employmentIdOf = async (userId: string) => {
    const [row] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(and(eq(employments.organizationId, ORGANIZATION_ID), eq(employments.userId, userId)));
    return row!.id;
  };

  const seedSession = async (input: {
    employmentId: string;
    day: number;
    startedAt: Date;
    endedAt: Date | null;
    breaks?: { startedAt: Date; endedAt: Date | null }[];
  }) => {
    const id = uuidv4();
    await db.insert(attendanceSessions).values({
      id,
      employmentId: input.employmentId,
      businessDate: businessDate(input.day),
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      timezone: ZONE,
      closedBy: input.endedAt ? "USER" : null,
    });

    for (const entry of input.breaks ?? []) {
      await db.insert(attendanceBreaks).values({ id: uuidv4(), sessionId: id, ...entry });
    }

    return id;
  };

  /**
   * Three days worked by hand, with the figures `docs/attendance.md` gives:
   *
   * - the 1st, 8:30 of presence with a 0:20 break — over the six-hour threshold,
   *   so the 0:30 allowance comes off instead and 8:00 is worked, exactly the
   *   required day;
   * - the 2nd, 4:00 of presence with a 0:10 break — under the threshold, so only
   *   the break taken comes off and 3:50 is worked;
   * - the 3rd, a night shift from 22:00 to 02:00 the next morning: 4:00 counted
   *   wholly on the 3rd, leaving the 4th with nothing.
   */
  const seedMonth = async () => {
    await seedSession({
      employmentId: memberEmploymentId,
      day: 1,
      startedAt: at(1, "06:00"),
      endedAt: at(1, "14:30"),
      breaks: [{ startedAt: at(1, "10:00"), endedAt: at(1, "10:20") }],
    });
    await seedSession({
      employmentId: memberEmploymentId,
      day: 2,
      startedAt: at(2, "07:00"),
      endedAt: at(2, "11:00"),
      breaks: [{ startedAt: at(2, "09:00"), endedAt: at(2, "09:10") }],
    });
    await seedSession({
      employmentId: memberEmploymentId,
      day: 3,
      startedAt: at(3, "20:00"),
      endedAt: new Date(at(3, "20:00").getTime() + 4 * 60 * 60 * 1000),
    });
  };

  const WORKED = 480 + 230 + 240;
  const REQUIRED = 480 * DAYS_IN_MONTH;

  const getMonth = (cookie: string, query: Record<string, string | number> = {}) =>
    request(app)
      .get("/api/attendance/month")
      .query({ organizationId: ORGANIZATION_ID, year, month, ...query })
      .set("Cookie", cookie);

  const patchEmployment = (cookie: string, employmentId: string, body: unknown) =>
    request(app)
      .patch(`/api/employment/${employmentId}`)
      .set("Cookie", cookie)
      .send(body as object);

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    owner = await createTestUser("month-owner@test.com", "Olivia Owner", "password123");
    groupAdmin = await createTestUser("month-admin@test.com", "Gina Groupadmin", "password123");
    member = await createTestUser("month-member@test.com", "Milo Member", "password123");
    colleague = await createTestUser("month-colleague@test.com", "Cora Colleague", "password123");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    const groupId = uuidv4();
    engineeringGroupId = groupId;
    await db.insert(groups).values({
      id: groupId,
      organizationId: ORGANIZATION_ID,
      groupName: "Engineering",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });

    for (const [user, adminAccess] of [
      [groupAdmin, true],
      [member, false],
      [colleague, false],
    ] as const) {
      await db.insert(groupUsers).values({
        id: uuidv4(),
        userId: user.id,
        groupId,
        viewAccess: true,
        adminAccess,
        approverAccess: false,
        controlledUser: true,
      });
      await syncEmployment(ORGANIZATION_ID, user.id);
    }

    memberEmploymentId = await employmentIdOf(member.id);
    colleagueEmploymentId = await employmentIdOf(colleague.id);

    ownerCookie = await authCookieFor(owner.id);
    groupAdminCookie = await authCookieFor(groupAdmin.id);
    memberCookie = await authCookieFor(member.id);
    colleagueCookie = await authCookieFor(colleague.id);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(attendanceSessions);
    // The spell as well as the override: an Employment created by the seed
    // starts now, and the seeded month is the one before this — every date of
    // it would fall outside a spell nobody moved back.
    await db
      .update(employments)
      .set({ requiredMinutesPerDay: null, startedAt: EMPLOYED_SINCE, endedAt: null })
      .where(eq(employments.organizationId, ORGANIZATION_ID));
    await settings();
    await proActive();
  });

  describe("the figures", () => {
    it("matches the day and the month worked out by hand", async () => {
      await seedMonth();

      const { body } = await getMonth(memberCookie).expect(200);

      expect(body).toMatchObject({
        organizationId: ORGANIZATION_ID,
        employmentId: memberEmploymentId,
        timezone: ZONE,
        year,
        month,
        balanceMode: "DAILY",
        requiredMinutesPerDay: 480,
        requiredMinutesOverride: null,
        breakMinutes: 30,
        breakThresholdMinutes: 360,
      });
      expect(body.days).toHaveLength(DAYS_IN_MONTH);

      expect(body.days[0]).toMatchObject({
        businessDate: businessDate(1),
        presenceMinutes: 510,
        breaksMinutes: 20,
        deductedMinutes: 30,
        workedMinutes: 480,
        requiredMinutes: 480,
        balanceMinutes: 0,
        upcoming: false,
        open: false,
        flagged: false,
      });
      expect(body.days[0].sessions).toHaveLength(1);
      expect(body.days[0].sessions[0].breaks).toHaveLength(1);

      expect(body.days[1]).toMatchObject({
        presenceMinutes: 240,
        breaksMinutes: 10,
        deductedMinutes: 10,
        workedMinutes: 230,
        balanceMinutes: -250,
      });

      // The night shift belongs wholly to the day it started.
      expect(body.days[2]).toMatchObject({ presenceMinutes: 240, workedMinutes: 240 });
      expect(body.days[3]).toMatchObject({ presenceMinutes: 0, workedMinutes: 0, sessions: [] });

      expect(body.totals).toEqual({
        presenceMinutes: 510 + 240 + 240,
        workedMinutes: WORKED,
        requiredMinutes: REQUIRED,
        requiredRangeMinutes: REQUIRED,
        balanceMinutes: WORKED - REQUIRED,
        flaggedDays: 0,
        excludedDays: 0,
      });
    });

    it("drops the per-day balance in MONTHLY mode and keeps the month's", async () => {
      await seedMonth();
      await settings({ balanceMode: balanceMode.Monthly });

      const { body } = await getMonth(memberCookie).expect(200);

      expect(body.balanceMode).toBe("MONTHLY");
      expect(
        body.days.every((day: { balanceMinutes: number | null }) => day.balanceMinutes === null)
      ).toBe(true);
      expect(body.totals.balanceMinutes).toBe(WORKED - REQUIRED);
    });

    it("measures against the Employment's override once one is set", async () => {
      await seedMonth();
      await patchEmployment(ownerCookie, memberEmploymentId, {
        requiredMinutesPerDay: 240,
      }).expect(200);

      const { body } = await getMonth(memberCookie).expect(200);

      expect(body).toMatchObject({ requiredMinutesPerDay: 240, requiredMinutesOverride: 240 });
      expect(body.days[0]).toMatchObject({ requiredMinutes: 240, balanceMinutes: 240 });
      expect(body.totals).toMatchObject({
        requiredMinutes: 240 * DAYS_IN_MONTH,
        balanceMinutes: WORKED - 240 * DAYS_IN_MONTH,
      });
    });

    it("owes nothing on the days of the current month still to come", async () => {
      const now = new Date();
      const { body } = await request(app)
        .get("/api/attendance/month")
        .query({
          organizationId: ORGANIZATION_ID,
          year: now.getUTCFullYear(),
          month: now.getUTCMonth() + 1,
        })
        .set("Cookie", memberCookie)
        .expect(200);

      const today = body.businessDate as string;
      const upcoming = body.days.filter((day: { upcoming: boolean }) => day.upcoming);

      expect(upcoming.every((day: { businessDate: string }) => day.businessDate > today)).toBe(
        true
      );
      expect(upcoming.every((day: { balanceMinutes: null }) => day.balanceMinutes === null)).toBe(
        true
      );
      // Not simply "less than": run on the last day of a month there is
      // nothing still to come, and the two figures are equal.
      expect(body.totals.requiredRangeMinutes - body.totals.requiredMinutes).toBe(
        upcoming.length * 480
      );
    });

    it("flags a day the sweep closed and one still open behind it", async () => {
      await seedSession({
        employmentId: memberEmploymentId,
        day: 5,
        startedAt: at(5, "06:00"),
        endedAt: at(5, "22:00"),
      });
      await db
        .update(attendanceSessions)
        .set({ closedBy: "SWEEP" })
        .where(eq(attendanceSessions.businessDate, businessDate(5)));
      await seedSession({
        employmentId: memberEmploymentId,
        day: 6,
        startedAt: at(6, "06:00"),
        endedAt: null,
      });

      const { body } = await getMonth(memberCookie).expect(200);

      expect(body.days[4]).toMatchObject({ autoClosed: true, flagged: true });
      expect(body.days[5]).toMatchObject({ open: true, flagged: true });
      expect(body.totals.flaggedDays).toBe(2);
    });

    it("answers an organization that never set attendance up with an empty month", async () => {
      await db.delete(attendanceSessions);
      const second = await createTestUser("month-solo@test.com", "Sam Solo", "password123");
      const secondOrganization = await ensureOrganizationForUser(second.id);
      await syncEmployment(secondOrganization.id, second.id);

      const { body } = await request(app)
        .get("/api/attendance/month")
        .query({ organizationId: secondOrganization.id, year, month })
        .set("Cookie", await authCookieFor(second.id))
        .expect(200);

      expect(body).toMatchObject({ timezone: null, businessDate: null });
      expect(body.days).toHaveLength(DAYS_IN_MONTH);
      expect(body.totals.workedMinutes).toBe(0);
    });
  });

  describe("whose month it is", () => {
    it("refuses a colleague's Employment rather than quietly answering with one's own", async () => {
      await seedMonth();

      const refused = await getMonth(colleagueCookie, { userId: member.id }).expect(403);
      expect(refused.body.errors[0].context).toMatchObject({ reason: "OWN_EMPLOYMENT_ONLY" });

      // Nor does an organization admin read anyone else here: the team
      // dashboard is where the visibility matrix lives.
      await getMonth(ownerCookie, { userId: member.id }).expect(403);
    });

    it("answers each caller with their own month, naming themselves or nobody", async () => {
      await seedMonth();
      await seedSession({
        employmentId: colleagueEmploymentId,
        day: 1,
        startedAt: at(1, "06:00"),
        endedAt: at(1, "18:00"),
      });

      const { body } = await getMonth(colleagueCookie, { userId: colleague.id }).expect(200);

      expect(body.employmentId).toBe(colleagueEmploymentId);
      expect(body.days[0].sessions).toHaveLength(1);
      expect(body.days[0].presenceMinutes).toBe(720);
      expect(body.totals.workedMinutes).toBe(690);

      // The member's own month is untouched by the colleague's sessions.
      const mine = await getMonth(memberCookie).expect(200);
      expect(mine.body.employmentId).toBe(memberEmploymentId);
      expect(mine.body.totals.workedMinutes).toBe(WORKED);
    });

    it("refuses a caller with no Employment in the organization", async () => {
      const outsider = await createTestUser("month-outsider@test.com", "Otto", "password123");

      await request(app)
        .get("/api/attendance/month")
        .query({ organizationId: ORGANIZATION_ID, year, month })
        .set("Cookie", await authCookieFor(outsider.id))
        .expect(404);
    });

    it("refuses a month outside the calendar", async () => {
      await getMonth(memberCookie, { month: 13 }).expect(422);
      await getMonth(memberCookie, { year: "last" }).expect(422);
    });
  });

  describe("the required-time override", () => {
    it("is an organization admin's to set and to clear", async () => {
      const set = await patchEmployment(ownerCookie, memberEmploymentId, {
        requiredMinutesPerDay: 300,
      }).expect(200);
      expect(set.body).toMatchObject({ id: memberEmploymentId, requiredMinutesPerDay: 300 });

      const roster = await request(app)
        .get("/api/employment/list")
        .query({ organizationId: ORGANIZATION_ID })
        .set("Cookie", ownerCookie)
        .expect(200);
      expect(
        roster.body.find((row: { id: string }) => row.id === memberEmploymentId)
      ).toMatchObject({ requiredMinutesPerDay: 300 });

      const cleared = await patchEmployment(ownerCookie, memberEmploymentId, {
        requiredMinutesPerDay: null,
      }).expect(200);
      expect(cleared.body.requiredMinutesPerDay).toBeNull();
    });

    it("is refused to a group admin and to the person themselves", async () => {
      await patchEmployment(groupAdminCookie, memberEmploymentId, {
        requiredMinutesPerDay: 300,
      }).expect(403);

      await patchEmployment(memberCookie, memberEmploymentId, {
        requiredMinutesPerDay: 300,
      }).expect(403);

      const [row] = await db
        .select({ requiredMinutesPerDay: employments.requiredMinutesPerDay })
        .from(employments)
        .where(eq(employments.id, memberEmploymentId));
      expect(row!.requiredMinutesPerDay).toBeNull();
    });

    it("refuses an unknown Employment and an out-of-range figure", async () => {
      await patchEmployment(ownerCookie, uuidv4(), { requiredMinutesPerDay: 300 }).expect(404);
      await patchEmployment(ownerCookie, memberEmploymentId, {
        requiredMinutesPerDay: 2000,
      }).expect(422);
      await patchEmployment(ownerCookie, memberEmploymentId, {}).expect(422);
    });
  });
  /**
   * The organization keeps Monday to Friday and a holiday calendar of its own.
   * `ZZ` is not a country the dataset knows, so nothing is ever filled behind
   * this suite's back and the only holiday in the month is the one seeded
   * below — the alternative is a real calendar that moves with whichever month
   * the suite runs in.
   */
  describe("excluded days", () => {
    /** The first Monday of the seeded month: every day below is counted from it. */
    const anchor = (() => {
      for (let day = 1; day <= 7; day += 1) {
        if (new Date(`${businessDate(day)}T00:00:00Z`).getUTCDay() === 1) return day;
      }
      return 1;
    })();

    const MONDAY = anchor;
    const VACATION_DAY = anchor + 1;
    const HALF_DAY = anchor + 2;
    const PENDING_DAY = anchor + 3;
    const HOME_OFFICE_DAY = anchor + 4;
    const SATURDAY = anchor + 5;
    const SUNDAY = anchor + 6;
    const HOLIDAY = anchor + 7;
    const REJECTED_DAY = anchor + 8;
    const MIRRORED_DAY = anchor + 9;

    const weekendDays = [...Array(DAYS_IN_MONTH).keys()]
      .map((index) => index + 1)
      .filter((day) => [0, 6].includes(new Date(`${businessDate(day)}T00:00:00Z`).getUTCDay()));
    const workingDaysInMonth = DAYS_IN_MONTH - weekendDays.length;

    let mirrorGroupId: string;

    const bookDay = async (input: {
      day: number;
      vacationType: CalendarRecordType;
      halfDay?: boolean;
      approved?: boolean;
      rejected?: boolean;
      groupId?: string;
    }) => {
      await db.insert(vacation).values({
        id: uuidv4(),
        userId: member.id,
        groupId: input.groupId ?? engineeringGroupId,
        requestId: uuidv4(),
        requestedDay: businessDate(input.day),
        vacationType: input.vacationType,
        halfDay: input.halfDay ?? false,
        approvedAt: input.approved === false ? null : new Date(),
        approvedBy: input.approved === false ? null : owner.id,
        rejectedAt: input.rejected ? new Date() : null,
        rejectedBy: input.rejected ? owner.id : null,
      });
    };

    const dayOf = (body: { days: { businessDate: string }[] }, day: number) =>
      body.days.find((entry) => entry.businessDate === businessDate(day));

    beforeAll(async () => {
      await db.insert(bankHolidays).values({
        id: uuidv4(),
        date: businessDate(HOLIDAY),
        name: "Founders' Day",
        country: "ZZ",
      });

      const mirrorOrganizationId = (await ensureOrganizationForUser(colleague.id)).id;
      mirrorGroupId = uuidv4();
      await db.insert(groups).values({
        id: mirrorGroupId,
        organizationId: mirrorOrganizationId,
        groupName: "Another organization",
        managerUserId: colleague.id,
        mainApprovalUser: colleague.id,
      });

      await bookDay({ day: VACATION_DAY, vacationType: CalendarRecordType.Vacation });
      await bookDay({ day: HALF_DAY, vacationType: CalendarRecordType.SickDay, halfDay: true });
      await bookDay({
        day: PENDING_DAY,
        vacationType: CalendarRecordType.Vacation,
        approved: false,
      });
      await bookDay({ day: HOME_OFFICE_DAY, vacationType: CalendarRecordType.HomeOffice });
      await bookDay({
        day: REJECTED_DAY,
        vacationType: CalendarRecordType.Vacation,
        rejected: true,
      });
      // Booked in another organization's group and only projected into this
      // one. The projection is a read-side view: it owes this organization
      // nothing, so nothing here joins it.
      await bookDay({
        day: MIRRORED_DAY,
        vacationType: CalendarRecordType.Vacation,
        groupId: mirrorGroupId,
      });
      await db.insert(groupMirrors).values({
        id: uuidv4(),
        userId: member.id,
        sourceGroupId: mirrorGroupId,
        targetGroupId: engineeringGroupId,
      });
    });

    afterAll(async () => {
      await db.delete(bankHolidays).where(eq(bankHolidays.country, "ZZ"));
    });

    beforeEach(async () => {
      await settings({ workingDays: [1, 2, 3, 4, 5], holidayCountry: "ZZ" });
    });

    it("owes nothing on a weekend, a public holiday or an approved absence", async () => {
      const { body } = await getMonth(memberCookie).expect(200);

      expect(dayOf(body, SATURDAY)).toMatchObject({
        requiredMinutes: 0,
        balanceMinutes: null,
        exclusion: { cause: "NON_WORKING_DAY", extent: "FULL", label: null },
      });
      expect(dayOf(body, SUNDAY)).toMatchObject({ exclusion: { cause: "NON_WORKING_DAY" } });
      expect(dayOf(body, HOLIDAY)).toMatchObject({
        requiredMinutes: 0,
        exclusion: { cause: "HOLIDAY", extent: "FULL", label: "Founders' Day" },
      });
      expect(dayOf(body, VACATION_DAY)).toMatchObject({
        requiredMinutes: 0,
        exclusion: { cause: "ABSENCE", extent: "FULL", label: "VACATION" },
      });
    });

    it("halves the day a half-day sick day covers", async () => {
      const { body } = await getMonth(memberCookie).expect(200);

      expect(dayOf(body, HALF_DAY)).toMatchObject({
        requiredMinutes: 240,
        exclusion: { cause: "ABSENCE", extent: "HALF", label: "SICK_DAY" },
      });
    });

    it("excuses nobody with a booking that is pending, rejected, home office, or another organization's", async () => {
      const { body } = await getMonth(memberCookie).expect(200);

      for (const day of [PENDING_DAY, HOME_OFFICE_DAY, REJECTED_DAY, MIRRORED_DAY]) {
        expect(dayOf(body, day)).toMatchObject({ requiredMinutes: 480, exclusion: null });
      }
    });

    it("counts a clock-in on the holiday and flags it", async () => {
      await seedSession({
        employmentId: memberEmploymentId,
        day: HOLIDAY,
        startedAt: at(HOLIDAY, "07:00"),
        endedAt: at(HOLIDAY, "09:10"),
      });

      const { body } = await getMonth(memberCookie).expect(200);

      expect(dayOf(body, HOLIDAY)).toMatchObject({
        presenceMinutes: 130,
        workedMinutes: 130,
        requiredMinutes: 0,
        balanceMinutes: 130,
        excludedClockIn: true,
        flagged: true,
      });
      expect(body.totals.workedMinutes).toBe(130);
      expect(body.totals.flaggedDays).toBe(1);
    });

    it("adds the month up the way the rules say, day by day", async () => {
      await seedSession({
        employmentId: memberEmploymentId,
        day: MONDAY,
        startedAt: at(MONDAY, "06:00"),
        endedAt: at(MONDAY, "14:30"),
        breaks: [{ startedAt: at(MONDAY, "10:00"), endedAt: at(MONDAY, "10:20") }],
      });
      await seedSession({
        employmentId: memberEmploymentId,
        day: HALF_DAY,
        startedAt: at(HALF_DAY, "06:00"),
        endedAt: at(HALF_DAY, "10:10"),
      });
      await seedSession({
        employmentId: memberEmploymentId,
        day: HOLIDAY,
        startedAt: at(HOLIDAY, "07:00"),
        endedAt: at(HOLIDAY, "09:10"),
      });

      const { body } = await getMonth(memberCookie).expect(200);

      // Every working day owes 8:00 except the vacation and the holiday, which
      // owe nothing, and the half sick day, which owes four hours.
      const required = 480 * (workingDaysInMonth - 2) - 240;
      const worked = 480 + 250 + 130;

      expect(body.totals).toEqual({
        presenceMinutes: 510 + 250 + 130,
        workedMinutes: worked,
        requiredMinutes: required,
        requiredRangeMinutes: required,
        balanceMinutes: worked - required,
        flaggedDays: 1,
        // The weekends, the vacation and the holiday. The half day is not one.
        excludedDays: weekendDays.length + 2,
      });
    });

    it("treats no day as a holiday for an organization that names no country", async () => {
      await settings({ workingDays: [1, 2, 3, 4, 5], holidayCountry: null });

      const { body } = await getMonth(memberCookie).expect(200);

      expect(dayOf(body, HOLIDAY)).toMatchObject({ requiredMinutes: 480, exclusion: null });
      expect(body.totals.excludedDays).toBe(weekendDays.length + 1);
    });

    it("owes nothing for the days before the Employment began", async () => {
      await db
        .update(employments)
        .set({ startedAt: at(HOLIDAY, "06:00") })
        .where(eq(employments.id, memberEmploymentId));

      const { body } = await getMonth(memberCookie).expect(200);

      expect(dayOf(body, MONDAY)).toMatchObject({
        requiredMinutes: 0,
        balanceMinutes: null,
        exclusion: { cause: "NOT_EMPLOYED", extent: "FULL", label: null },
      });
      // The days before somebody joined are not days off they were given, so
      // only the weekends after it count — and the holiday they joined on.
      expect(body.totals.excludedDays).toBe(weekendDays.filter((day) => day > HOLIDAY).length + 1);
      expect(body.totals.requiredMinutes).toBe(
        480 *
          [...Array(DAYS_IN_MONTH).keys()]
            .map((index) => index + 1)
            .filter((day) => day > HOLIDAY && !weekendDays.includes(day)).length
      );
    });

    it("owes nothing for the days after it ended, and keeps the last day worked", async () => {
      await db
        .update(employments)
        .set({ endedAt: at(MONDAY, "16:00") })
        .where(eq(employments.id, memberEmploymentId));

      const { body } = await getMonth(memberCookie).expect(200);

      expect(dayOf(body, MONDAY)).toMatchObject({ requiredMinutes: 480, exclusion: null });
      expect(dayOf(body, HOLIDAY)).toMatchObject({
        requiredMinutes: 0,
        exclusion: { cause: "NOT_EMPLOYED" },
      });
      const owedBefore = [...Array(MONDAY).keys()]
        .map((index) => index + 1)
        .filter((day) => !weekendDays.includes(day)).length;
      expect(body.totals.requiredRangeMinutes).toBe(480 * owedBefore);
    });
  });
});
