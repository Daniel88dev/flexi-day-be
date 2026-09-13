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
import {
  attendanceBreaks,
  attendanceClosedBy,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";

const ZONE = "Europe/Prague";

/** The month before the one the suite runs in, so every seeded day has already happened. */
const previousMonth = () => {
  const now = new Date();
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 };
};

const { year, month } = previousMonth();
const businessDate = (day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const at = (day: number, time: string) => new Date(`${businessDate(day)}T${time}:00Z`);
const weekdayOf = (day: number) => new Date(`${businessDate(day)}T00:00:00Z`).getUTCDay();

/** The first Monday of the month, and the Saturday that follows it. */
const MONDAY = (() => {
  for (let day = 1; day <= 7; day += 1) if (weekdayOf(day) === 1) return day;
  return 1;
})();
const SATURDAY = MONDAY + 5;

const EMPLOYED_SINCE = new Date("2020-01-01T00:00:00Z");

let ORGANIZATION_ID: string;

type Person = { id: string; name: string };

describe("team attendance", () => {
  let app: Express;

  let owner: Person;
  let manager: Person;
  let groupAdmin: Person;
  let member: Person;
  let colleague: Person;
  let salesAdmin: Person;
  let salesMember: Person;

  const cookies = new Map<string, string>();
  const employmentIds = new Map<string, string>();

  let engineeringId: string;
  let salesId: string;

  const cookieOf = (person: Person) => cookies.get(person.id)!;

  const getTeam = (person: Person, query: Record<string, string> = {}) =>
    request(app)
      .get("/api/attendance/team")
      .query({
        organizationId: ORGANIZATION_ID,
        from: businessDate(MONDAY),
        to: businessDate(MONDAY + 6),
        ...query,
      })
      .set("Cookie", cookieOf(person));

  const userIdsOf = (body: { people: { userId: string }[] }) =>
    body.people.map((person) => person.userId).sort();

  const seedSession = async (input: {
    person: Person;
    day: number;
    startedAt: Date;
    endedAt: Date | null;
    closedBy?: attendanceClosedBy;
    breaks?: { startedAt: Date; endedAt: Date | null; autoClosed?: boolean }[];
  }) => {
    const id = uuidv4();
    await db.insert(attendanceSessions).values({
      id,
      employmentId: employmentIds.get(input.person.id)!,
      businessDate: businessDate(input.day),
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      timezone: ZONE,
      closedBy: input.endedAt ? (input.closedBy ?? attendanceClosedBy.User) : null,
    });
    for (const entry of input.breaks ?? []) {
      await db.insert(attendanceBreaks).values({
        id: uuidv4(),
        sessionId: id,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        autoClosed: entry.autoClosed ?? false,
      });
    }
    return id;
  };

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    const make = async (email: string, name: string): Promise<Person> => {
      const user = await createTestUser(email, name, "password123");
      return { id: user.id, name };
    };

    owner = await make("team-owner@test.com", "Olivia Owner");
    manager = await make("team-manager@test.com", "Marco Manager");
    groupAdmin = await make("team-admin@test.com", "Gina Groupadmin");
    member = await make("team-member@test.com", "Milo Member");
    colleague = await make("team-colleague@test.com", "Cora Colleague");
    salesAdmin = await make("team-sales-admin@test.com", "Sam Salesadmin");
    salesMember = await make("team-sales-member@test.com", "Tara Salesmember");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    engineeringId = uuidv4();
    await db.insert(groups).values({
      id: engineeringId,
      organizationId: ORGANIZATION_ID,
      groupName: "Engineering",
      managerUserId: manager.id,
      mainApprovalUser: manager.id,
    });
    salesId = uuidv4();
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
      [colleague, engineeringId, false],
      // In both groups, so each group's admin is told about their own only.
      [colleague, salesId, false],
      [salesAdmin, salesId, true],
      [salesMember, salesId, false],
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

    for (const person of [owner, manager, groupAdmin, member, colleague, salesAdmin, salesMember]) {
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

    await upsertAttendanceSettings(ORGANIZATION_ID, {
      ...ATTENDANCE_SETTINGS_DEFAULTS,
      balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
      attendanceEnabled: true,
      timezone: ZONE,
      workingDays: [1, 2, 3, 4, 5],
      holidayCountry: null,
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(attendanceSessions);
    await db
      .update(employments)
      .set({ requiredMinutesPerDay: null, startedAt: EMPLOYED_SINCE, endedAt: null })
      .where(eq(employments.organizationId, ORGANIZATION_ID));
  });

  describe("who sees whom", () => {
    it("refuses an employee", async () => {
      await getTeam(member).expect(403);
    });

    it("shows a group admin their group's members, and not the manager or anyone else", async () => {
      const { body } = await getTeam(groupAdmin).expect(200);

      expect(body.scope).toBe("GROUPS");
      expect(body.group).toBeNull();
      expect(userIdsOf(body)).toEqual([groupAdmin.id, member.id, colleague.id].sort());
    });

    it("does not show a group admin of another group", async () => {
      const { body } = await getTeam(salesAdmin).expect(200);

      expect(userIdsOf(body)).toEqual([salesAdmin.id, salesMember.id, colleague.id].sort());
      expect(userIdsOf(body)).not.toContain(member.id);
    });

    it("names on a row only the groups the viewer administers", async () => {
      const groupsOf = (body: { people: { userId: string; groups: { groupName: string }[] }[] }) =>
        body.people
          .find((person) => person.userId === colleague.id)!
          .groups.map((group) => group.groupName)
          .sort();

      expect(groupsOf((await getTeam(groupAdmin).expect(200)).body)).toEqual(["Engineering"]);
      expect(groupsOf((await getTeam(salesAdmin).expect(200)).body)).toEqual(["Sales"]);
      expect(groupsOf((await getTeam(owner).expect(200)).body)).toEqual(["Engineering", "Sales"]);
    });

    it("shows the manager their members but not their own row", async () => {
      const { body } = await getTeam(manager).expect(200);

      expect(userIdsOf(body)).toEqual([groupAdmin.id, member.id, colleague.id].sort());
    });

    it("shows an org admin everyone, the manager and themselves included", async () => {
      const { body } = await getTeam(owner).expect(200);

      expect(body.scope).toBe("ORGANIZATION");
      expect(userIdsOf(body)).toEqual(
        [
          owner.id,
          manager.id,
          groupAdmin.id,
          member.id,
          colleague.id,
          salesAdmin.id,
          salesMember.id,
        ].sort()
      );

      const managerRow = body.people.find(
        (person: { userId: string }) => person.userId === manager.id
      );
      expect(managerRow.groups).toEqual([]);
      const memberRow = body.people.find(
        (person: { userId: string }) => person.userId === member.id
      );
      expect(memberRow.groups).toEqual([{ id: engineeringId, groupName: "Engineering" }]);
    });

    it("narrows an org admin to one group", async () => {
      const { body } = await getTeam(owner, { groupId: engineeringId }).expect(200);

      expect(body.group).toEqual({ id: engineeringId, groupName: "Engineering" });
      expect(userIdsOf(body)).toEqual([groupAdmin.id, member.id, colleague.id].sort());
    });

    it("lets a group admin narrow to their own group and keeps their scope", async () => {
      const { body } = await getTeam(groupAdmin, { groupId: engineeringId }).expect(200);

      expect(body.scope).toBe("GROUPS");
      expect(body.group).toEqual({ id: engineeringId, groupName: "Engineering" });
      expect(userIdsOf(body)).toEqual([groupAdmin.id, member.id, colleague.id].sort());
    });

    it("refuses a group admin a group that is not theirs, and 404s a group that is not here", async () => {
      await getTeam(salesAdmin, { groupId: engineeringId }).expect(403);
      await getTeam(owner, { groupId: uuidv4() }).expect(404);
    });

    it("leaves an ended Employment out", async () => {
      await db
        .update(employments)
        .set({ endedAt: new Date() })
        .where(eq(employments.userId, colleague.id));

      const { body } = await getTeam(owner).expect(200);

      expect(userIdsOf(body)).not.toContain(colleague.id);
    });

    it("sorts people by name", async () => {
      const { body } = await getTeam(owner).expect(200);

      const names = body.people.map((person: { user: { name: string } }) => person.user.name);
      expect(names).toEqual([...names].sort());
    });
  });

  describe("the range", () => {
    it("rejects a range that ends before it starts, or runs longer than a quarter", async () => {
      await getTeam(owner, { from: businessDate(5), to: businessDate(4) }).expect(422);
      await getTeam(owner, { from: `${year}-01-01`, to: `${year}-06-30` }).expect(422);
      await getTeam(owner, { from: "not-a-date" }).expect(422);
    });

    it("answers every date of the range for every person, and the rules", async () => {
      const { body } = await getTeam(owner).expect(200);

      expect(body).toMatchObject({
        organizationId: ORGANIZATION_ID,
        timezone: ZONE,
        from: businessDate(MONDAY),
        to: businessDate(MONDAY + 6),
        balanceMode: "DAILY",
        requiredMinutesPerDay: 480,
        breakMinutes: 30,
        breakThresholdMinutes: 360,
      });
      for (const person of body.people) {
        expect(person.days).toHaveLength(7);
        expect(person.days[0].businessDate).toBe(businessDate(MONDAY));
        expect(person.days[5].exclusion).toMatchObject({ cause: "NON_WORKING_DAY" });
        expect(person.totals.requiredMinutes).toBe(5 * 480);
      }
    });
  });

  describe("flags and who is in now", () => {
    beforeEach(async () => {
      // Monday: the sweep closed it at the ceiling.
      await seedSession({
        person: member,
        day: MONDAY,
        startedAt: at(MONDAY, "06:00"),
        endedAt: at(MONDAY, "22:00"),
        closedBy: attendanceClosedBy.Sweep,
      });
      // Tuesday: never clocked out — still open on a day that has passed.
      await seedSession({
        person: member,
        day: MONDAY + 1,
        startedAt: at(MONDAY + 1, "06:00"),
        endedAt: null,
      });
      // Saturday: clocked in on a day nobody owed.
      await seedSession({
        person: colleague,
        day: SATURDAY,
        startedAt: at(SATURDAY, "08:00"),
        endedAt: at(SATURDAY, "10:00"),
      });
      // Somebody else in right now, on a break, outside the range entirely.
      await seedSession({
        person: salesMember,
        day: MONDAY + 7,
        startedAt: at(MONDAY + 7, "07:00"),
        endedAt: null,
        breaks: [{ startedAt: at(MONDAY + 7, "09:00"), endedAt: null }],
      });
    });

    it("flags the auto-closed day, the day still open and the excluded-day clock-in", async () => {
      const { body } = await getTeam(owner).expect(200);

      const rowOf = (person: Person) =>
        body.people.find((entry: { userId: string }) => entry.userId === person.id);
      const dayOf = (row: { days: { businessDate: string }[] }, day: number) =>
        row.days.find((entry) => entry.businessDate === businessDate(day));

      expect(dayOf(rowOf(member), MONDAY)).toMatchObject({
        autoClosed: true,
        open: false,
        excludedClockIn: false,
        flagged: true,
        presenceMinutes: 960,
      });
      expect(dayOf(rowOf(member), MONDAY + 1)).toMatchObject({
        autoClosed: false,
        open: true,
        flagged: true,
      });
      expect(rowOf(member).totals.flaggedDays).toBe(2);

      expect(dayOf(rowOf(colleague), SATURDAY)).toMatchObject({
        excludedClockIn: true,
        flagged: true,
        workedMinutes: 120,
        requiredMinutes: 0,
        exclusion: { cause: "NON_WORKING_DAY", extent: "FULL" },
      });
      expect(dayOf(rowOf(colleague), MONDAY)).toMatchObject({ flagged: false });
    });

    it("lists who is in now, break and all, for the whole organization", async () => {
      const { body } = await getTeam(owner).expect(200);

      const inNow = [...body.inNow].sort((a: { userId: string }, b: { userId: string }) =>
        a.userId.localeCompare(b.userId)
      );
      expect(inNow.map((entry: { userId: string }) => entry.userId)).toEqual(
        [member.id, salesMember.id].sort()
      );
      expect(inNow.find((entry: { userId: string }) => entry.userId === member.id)).toMatchObject({
        employmentId: employmentIds.get(member.id),
        businessDate: businessDate(MONDAY + 1),
        startedAt: at(MONDAY + 1, "06:00").toISOString(),
        onBreak: false,
        breakStartedAt: null,
      });
      expect(
        inNow.find((entry: { userId: string }) => entry.userId === salesMember.id)
      ).toMatchObject({
        onBreak: true,
        breakStartedAt: at(MONDAY + 7, "09:00").toISOString(),
      });
    });

    it("keeps 'in now' inside the viewer's scope", async () => {
      const { body } = await getTeam(groupAdmin).expect(200);

      expect(body.inNow.map((entry: { userId: string }) => entry.userId)).toEqual([member.id]);
    });
  });
});
