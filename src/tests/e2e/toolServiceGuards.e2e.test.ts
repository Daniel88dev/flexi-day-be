import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { attendanceSessions } from "../../db/schema/attendance-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groupEvents } from "../../db/schema/group-event-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  type balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { readLog, readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { userBirthdays } from "../../db/schema/user-birthday-schema.js";
import type { AuthSession } from "../../middleware/authSession.js";
import {
  clockInOwn,
  clockOutOwn,
  readAttendanceDay,
  readOwnAttendanceMonth,
  readOwnAttendanceState,
} from "../../services/attendance/ownAttendance.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { listBirthdaysForMonth } from "../../services/birthday/birthdayCalendar.js";
import {
  readDirectoryOrganizations,
  readDirectoryPeople,
  readDirectoryProfile,
  readFormerDirectoryPeople,
  showProfileSection,
} from "../../services/directory/directoryLookups.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import {
  listGroupEventGroups,
  listGroupEventsForMonth,
} from "../../services/groupEvent/groupEventAccess.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { enableEnterpriseDirectory } from "./helpers/directoryWorld.js";
import { addMember, makeGroup, makeUser, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const authOf = (person: { id: string; name: string; email: string }): AuthSession => ({
  sessionId: "tool-service-guards",
  userId: person.id,
  userName: person.name,
  userEmail: person.email,
  emailVerified: true,
  channel: "app",
});

const YEAR = new Date().getUTCFullYear() + 1;
const MID_MARCH = `${YEAR.toString()}-03-12`;

/**
 * Olga owns the organization and manages Support. Mia is a plain member who
 * sees the whole group, Pavel a plain member without view access. Otto belongs
 * to no organization at all.
 */
const seed = async () => {
  const olga = await makeUser("Olga Owner");
  const mia = await makeUser("Mia Member");
  const pavel = await makeUser("Pavel Colleague");
  const otto = await makeUser("Otto Outsider");

  const organizationId = (await ensureOrganizationForUser(olga.id)).id;
  const support = await makeGroup("Support", olga.id, { organizationOwnerId: olga.id });
  await addMember(support, olga.id);
  await addMember(support, mia.id, { viewAccess: true });
  await addMember(support, pavel.id);
  for (const person of [olga, mia, pavel]) await syncEmployment(organizationId, person.id);

  const employmentOf = async (userId: string) => {
    const [row] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(and(eq(employments.userId, userId), eq(employments.organizationId, organizationId)));
    return row!.id;
  };

  return {
    organizationId,
    support,
    olga,
    mia,
    pavel,
    otto,
    employment: { olga: await employmentOf(olga.id), mia: await employmentOf(mia.id) },
  };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

describe("the attendance, directory and group-event operations the tool layer calls", () => {
  let s: Seeded;

  beforeEach(async () => {
    await db.delete(attendanceSessions);
    await cleanupTestData();
    await resetReportData();
    s = await seed();
  });

  afterAll(async () => {
    await db.delete(attendanceSessions);
    await cleanupTestData();
    await resetReportData();
  });

  describe("attendance", () => {
    beforeEach(async () => {
      await upsertAttendanceSettings(s.organizationId, {
        ...ATTENDANCE_SETTINGS_DEFAULTS,
        balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
        attendanceEnabled: true,
        timezone: "Europe/Prague",
      });
      await upsertSubscription(s.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
    });

    it("clocks the caller in and out", async () => {
      const opened = await clockInOwn({ auth: authOf(s.mia), organizationId: s.organizationId });
      expect(opened).toMatchObject({ endedAt: null, closedBy: null });

      const closed = await clockOutOwn({ auth: authOf(s.mia), organizationId: s.organizationId });
      expect(closed).toMatchObject({ id: opened.id, closedBy: "USER" });
      expect(closed.endedAt).not.toBeNull();
    });

    it("refuses to clock in a caller with no employment in the organization", async () => {
      await expect(
        clockInOwn({ auth: authOf(s.otto), organizationId: s.organizationId })
      ).rejects.toMatchObject({ code: 404, message: "No employment in this organization" });
    });

    it("refuses to clock in while the plan has lapsed, and still clocks out", async () => {
      await clockInOwn({ auth: authOf(s.mia), organizationId: s.organizationId });
      await upsertSubscription(s.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      await expect(
        clockOutOwn({ auth: authOf(s.mia), organizationId: s.organizationId })
      ).resolves.toMatchObject({ closedBy: "USER" });
      await expect(
        clockInOwn({ auth: authOf(s.mia), organizationId: s.organizationId })
      ).rejects.toMatchObject({ code: 402 });
    });

    it("refuses to clock out a caller who is not clocked in", async () => {
      await expect(
        clockOutOwn({ auth: authOf(s.mia), organizationId: s.organizationId })
      ).rejects.toMatchObject({ code: 409, message: "You are not clocked in" });
    });

    it("reads the caller's own clock state", async () => {
      await clockInOwn({ auth: authOf(s.mia), organizationId: s.organizationId });

      const state = await readOwnAttendanceState({
        auth: authOf(s.mia),
        organizationId: s.organizationId,
      });
      expect(state).toMatchObject({ employmentId: s.employment.mia, active: true });
      expect(state.openSession).not.toBeNull();
    });

    it("refuses the clock state to a caller with no employment", async () => {
      await expect(
        readOwnAttendanceState({ auth: authOf(s.otto), organizationId: s.organizationId })
      ).rejects.toMatchObject({ code: 404, message: "No employment in this organization" });
    });

    it("reads the caller's own month of worked time", async () => {
      const month = await readOwnAttendanceMonth({
        auth: authOf(s.mia),
        query: { organizationId: s.organizationId, year: YEAR, month: 3 },
      });
      expect(month).toMatchObject({ employmentId: s.employment.mia, year: YEAR, month: 3 });
      expect(month.days).toHaveLength(31);
    });

    it("refuses a month naming somebody else", async () => {
      await expect(
        readOwnAttendanceMonth({
          auth: authOf(s.mia),
          query: { organizationId: s.organizationId, userId: s.olga.id, year: YEAR, month: 3 },
        })
      ).rejects.toMatchObject({
        code: 403,
        message: "This month is only your own",
        errors: [expect.objectContaining({ publicContext: { reason: "OWN_EMPLOYMENT_ONLY" } })],
      });
    });

    it("reads the caller's own day", async () => {
      const day = await readAttendanceDay({
        auth: authOf(s.mia),
        query: { organizationId: s.organizationId, businessDate: MID_MARCH },
      });
      expect(day).toMatchObject({ userId: s.mia.id, employmentId: s.employment.mia });
    });

    it("refuses a plain member somebody else's day", async () => {
      await expect(
        readAttendanceDay({
          auth: authOf(s.mia),
          query: { organizationId: s.organizationId, userId: s.olga.id, businessDate: MID_MARCH },
        })
      ).rejects.toMatchObject({ code: 403, message: "No permission for this employment" });
    });
  });

  describe("directory", () => {
    beforeEach(async () => {
      await enableEnterpriseDirectory(s.organizationId, s.olga.id);
    });

    it("lists the caller's directory organizations", async () => {
      const organizations = await readDirectoryOrganizations({ auth: authOf(s.mia) });
      expect(organizations).toEqual(
        expect.arrayContaining([expect.objectContaining({ organizationId: s.organizationId })])
      );
      expect(await readDirectoryOrganizations({ auth: authOf(s.otto) })).toEqual([]);
    });

    it("lists the people of the caller's organization", async () => {
      const people = await readDirectoryPeople({
        auth: authOf(s.mia),
        organizationId: s.organizationId,
      });
      expect(JSON.stringify(people)).toContain(s.employment.olga);
    });

    it("refuses the people list to someone outside the organization", async () => {
      await expect(
        readDirectoryPeople({ auth: authOf(s.otto), organizationId: s.organizationId })
      ).rejects.toMatchObject({
        code: 403,
        message: "You are not one of this organization's people",
      });
    });

    it("refuses the Former list to a plain member", async () => {
      await expect(
        readFormerDirectoryPeople({ auth: authOf(s.mia), organizationId: s.organizationId })
      ).rejects.toMatchObject({ code: 403 });
      await expect(
        readFormerDirectoryPeople({ auth: authOf(s.olga), organizationId: s.organizationId })
      ).resolves.toBeDefined();
    });

    it("reads a profile in reach and refuses an outsider", async () => {
      const profile = await readDirectoryProfile({
        auth: authOf(s.mia),
        organizationId: s.organizationId,
        employmentId: s.employment.olga,
      });
      expect(profile).toMatchObject({ employmentId: s.employment.olga });

      await expect(
        readDirectoryProfile({
          auth: authOf(s.otto),
          organizationId: s.organizationId,
          employmentId: s.employment.olga,
        })
      ).rejects.toMatchObject({ code: 403 });
    });

    it("shows a Sensitive section and writes its Read log entry", async () => {
      const shown = await showProfileSection({
        auth: authOf(s.olga),
        organizationId: s.organizationId,
        employmentId: s.employment.mia,
        section: "contact",
      });
      expect(shown).toMatchObject({ section: "CONTACT", recorded: true });

      const rows = await db
        .select()
        .from(readLog)
        .where(eq(readLog.organizationId, s.organizationId));
      expect(rows).toEqual([
        expect.objectContaining({
          kind: readLogKind.Read,
          readerUserId: s.olga.id,
          subjectUserId: s.mia.id,
          employmentIds: [s.employment.mia],
          sections: ["CONTACT"],
          audience: readLogAudience.Owner,
        }),
      ]);
    });

    it("refuses a Sensitive section the caller cannot read, and writes nothing", async () => {
      await expect(
        showProfileSection({
          auth: authOf(s.pavel),
          organizationId: s.organizationId,
          employmentId: s.employment.mia,
          section: "contact",
        })
      ).rejects.toMatchObject({ code: 403, message: "You can't read this Section" });

      expect(
        await db.select().from(readLog).where(eq(readLog.organizationId, s.organizationId))
      ).toEqual([]);
    });

    it("refuses a section that does not open with Show", async () => {
      await expect(
        showProfileSection({
          auth: authOf(s.olga),
          organizationId: s.organizationId,
          employmentId: s.employment.mia,
          section: "employment",
        })
      ).rejects.toMatchObject({ code: 404, message: "Only Contact and Personal open with Show" });
    });
  });

  describe("group events", () => {
    beforeEach(async () => {
      await db.insert(groupEvents).values({
        id: generateRandomUUID(),
        groupId: s.support,
        createdByUserId: s.olga.id,
        title: "Team lunch",
        startDate: MID_MARCH,
        endDate: MID_MARCH,
      });
    });

    it("lists the events of the caller's groups", async () => {
      const events = await listGroupEventsForMonth({
        auth: authOf(s.pavel),
        query: { year: YEAR, month: 3 },
      });
      expect(events.map((event) => event.title)).toEqual(["Team lunch"]);

      const groups = await listGroupEventGroups({ auth: authOf(s.pavel) });
      expect(groups.map((group) => group.groupId)).toEqual([s.support]);
    });

    it("refuses one group's events to a caller outside it", async () => {
      await expect(
        listGroupEventsForMonth({
          auth: authOf(s.otto),
          query: { year: YEAR, month: 3, groupId: s.support },
        })
      ).rejects.toMatchObject({ code: 403, message: "No access to this group's events" });
    });
  });

  describe("birthdays", () => {
    beforeEach(async () => {
      await db.insert(userBirthdays).values([
        { userId: s.olga.id, month: 3, day: 12, year: null, shared: true },
        { userId: s.mia.id, month: 3, day: 20, year: null, shared: true },
      ]);
      await upsertSubscription(s.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
    });

    it("lists the visible birthdays of a group the caller sees whole", async () => {
      const rows = await listBirthdaysForMonth({
        auth: authOf(s.mia),
        year: YEAR,
        month: 3,
        groupId: s.support,
      });
      expect(rows.map((row) => [row.userId, row.date])).toEqual([
        [s.olga.id, MID_MARCH],
        [s.mia.id, `${YEAR.toString()}-03-20`],
      ]);
    });

    it("lists only the caller's own birthday without a group", async () => {
      const rows = await listBirthdaysForMonth({ auth: authOf(s.mia), year: YEAR, month: 3 });
      expect(rows.map((row) => row.userId)).toEqual([s.mia.id]);
    });

    it("refuses a group's birthdays to a member without view access", async () => {
      await expect(
        listBirthdaysForMonth({ auth: authOf(s.pavel), year: YEAR, month: 3, groupId: s.support })
      ).rejects.toMatchObject({ code: 403, message: "No access to view this group's records" });
    });
  });
});
