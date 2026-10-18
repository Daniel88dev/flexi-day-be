import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addLeave } from "./helpers/reportFixtures.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";

const previousMonth = () => {
  const now = new Date();
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 };
};

const { year, month } = previousMonth();
const businessDate = (day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const weekdayOf = (day: number) => new Date(`${businessDate(day)}T00:00:00Z`).getUTCDay();

const MONDAY = (() => {
  for (let day = 1; day <= 7; day += 1) if (weekdayOf(day) === 1) return day;
  return 1;
})();

/** Days of the month the absences land on, Tuesday to Friday of one week. */
const SICK_IN_SALES = MONDAY + 1;
const SICK_IN_ENGINEERING = MONDAY + 2;
const VACATION_IN_SALES = MONDAY + 3;
const HALF_SICK_IN_SALES = MONDAY + 4;

type Person = { id: string };
type Exclusion = { cause: string; extent: string; label: string | null } | null;
type TeamBody = {
  people: { userId: string; days: { businessDate: string; exclusion: Exclusion }[] }[];
};

/**
 * Cora belongs to Engineering and Sales. Gina is an `adminAccess` member of
 * Engineering and Marco its manager, with no standing in Sales. Sam is an
 * `adminAccess` member of Sales. Olivia owns the organization.
 */
describe("team attendance shows a Sick absence only to the admins of its own group", () => {
  let server: LoopbackServer;
  let organizationId: string;

  let owner: Person;
  let manager: Person;
  let engineeringAdmin: Person;
  let salesAdmin: Person;
  let colleague: Person;

  const getTeam = async (person: Person): Promise<TeamBody> => {
    const res = await request(server.url)
      .get("/api/attendance/team")
      .query({ organizationId, from: businessDate(MONDAY), to: businessDate(MONDAY + 6) })
      .set("Cookie", await authCookieFor(person.id));
    expect(res.status).toBe(200);
    return res.body as TeamBody;
  };

  const colleagueDay = (body: TeamBody, day: number): Exclusion => {
    const row = body.people.find((person) => person.userId === colleague.id);
    expect(row).toBeDefined();
    return row!.days.find((entry) => entry.businessDate === businessDate(day))?.exclusion ?? null;
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    const make = async (email: string, name: string): Promise<Person> => ({
      id: (await createTestUser(email, name, "password123")).id,
    });
    owner = await make("sick-att-owner@test.com", "Olivia Owner");
    manager = await make("sick-att-manager@test.com", "Marco Manager");
    engineeringAdmin = await make("sick-att-eng-admin@test.com", "Gina Groupadmin");
    salesAdmin = await make("sick-att-sales-admin@test.com", "Sam Salesadmin");
    colleague = await make("sick-att-colleague@test.com", "Cora Colleague");

    organizationId = (await ensureOrganizationForUser(owner.id)).id;

    const engineeringId = uuidv4();
    await db.insert(groups).values({
      id: engineeringId,
      organizationId,
      groupName: "Engineering",
      managerUserId: manager.id,
      mainApprovalUser: manager.id,
    });
    const salesId = uuidv4();
    await db.insert(groups).values({
      id: salesId,
      organizationId,
      groupName: "Sales",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });

    const memberships: [Person, string, boolean][] = [
      [engineeringAdmin, engineeringId, true],
      [colleague, engineeringId, false],
      [colleague, salesId, false],
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

    for (const person of [owner, manager, engineeringAdmin, salesAdmin, colleague]) {
      await syncEmployment(organizationId, person.id);
    }
    await db
      .update(employments)
      .set({ startedAt: new Date("2020-01-01T00:00:00Z"), endedAt: null })
      .where(eq(employments.organizationId, organizationId));

    await upsertAttendanceSettings(organizationId, {
      ...ATTENDANCE_SETTINGS_DEFAULTS,
      balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
      attendanceEnabled: true,
      timezone: "Europe/Prague",
      workingDays: [1, 2, 3, 4, 5],
      holidayCountry: null,
    });

    await addLeave(salesId, colleague.id, businessDate(SICK_IN_SALES), {
      type: CalendarRecordType.Sick,
    });
    await addLeave(engineeringId, colleague.id, businessDate(SICK_IN_ENGINEERING), {
      type: CalendarRecordType.Sick,
    });
    await addLeave(salesId, colleague.id, businessDate(VACATION_IN_SALES), {
      type: CalendarRecordType.Vacation,
    });
    await addLeave(salesId, colleague.id, businessDate(HALF_SICK_IN_SALES), {
      type: CalendarRecordType.Sick,
      halfDay: true,
    });
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  describe.each([
    ["an adminAccess member of another group", () => engineeringAdmin],
    ["the manager of another group", () => manager],
  ])("%s", (_, viewer) => {
    it("sees a shared member's Sick booked in a group they don't administer as Away", async () => {
      const body = await getTeam(viewer());

      expect(colleagueDay(body, SICK_IN_SALES)).toEqual({
        cause: "ABSENCE",
        extent: "FULL",
        label: "AWAY",
      });
      expect(colleagueDay(body, HALF_SICK_IN_SALES)).toEqual({
        cause: "ABSENCE",
        extent: "HALF",
        label: "AWAY",
      });
    });

    it("still sees Sick booked in the group they administer", async () => {
      const body = await getTeam(viewer());

      expect(colleagueDay(body, SICK_IN_ENGINEERING)?.label).toBe(CalendarRecordType.Sick);
    });

    it("still sees every other type from the other group as itself", async () => {
      const body = await getTeam(viewer());

      expect(colleagueDay(body, VACATION_IN_SALES)?.label).toBe(CalendarRecordType.Vacation);
    });
  });

  it("an admin of the absence's own group still sees Sick", async () => {
    const body = await getTeam(salesAdmin);

    expect(colleagueDay(body, SICK_IN_SALES)?.label).toBe(CalendarRecordType.Sick);
    expect(colleagueDay(body, HALF_SICK_IN_SALES)?.label).toBe(CalendarRecordType.Sick);
  });

  it("an org admin still sees Sick from every group", async () => {
    const body = await getTeam(owner);

    expect(colleagueDay(body, SICK_IN_SALES)?.label).toBe(CalendarRecordType.Sick);
    expect(colleagueDay(body, SICK_IN_ENGINEERING)?.label).toBe(CalendarRecordType.Sick);
  });

  it("the person still sees their own Sick on their month", async () => {
    const { body } = await request(server.url)
      .get("/api/attendance/month")
      .query({ organizationId, year, month })
      .set("Cookie", await authCookieFor(colleague.id))
      .expect(200);

    const day = (body.days as { businessDate: string; exclusion: Exclusion }[]).find(
      (entry) => entry.businessDate === businessDate(SICK_IN_SALES)
    );
    expect(day?.exclusion?.label).toBe(CalendarRecordType.Sick);
  });
});
