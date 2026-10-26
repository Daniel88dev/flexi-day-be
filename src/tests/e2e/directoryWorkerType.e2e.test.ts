import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  directoryProfileHistory,
  directoryProfiles,
} from "../../db/schema/directory-profile-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { directoryPermissionCells } from "../../db/schema/directory-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { balanceMode } from "../../db/schema/organization-attendance-settings-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { disableDirectory } from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { ATTENDANCE_SETTINGS_DEFAULTS } from "../../db/schema/organization-attendance-settings-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import {
  addLeave,
  addMember,
  addQuota,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { rolloverQuotasForYear } from "../../services/quotaRollover/quotaRolloverServices.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs, enableEnterpriseDirectory, errorCode as code } from "./helpers/directoryWorld.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ZONE = "Europe/Prague";

const PERSONAL = {
  homeAddress: { line1: "Vinohradská 12", city: "Praha", country: "CZ" },
  dateOfBirth: "1990-04-05",
};

describe("Change worker type", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
    await cleanupTestData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
  });

  /**
   * Olga owns an Enterprise organization with the directory and attendance on
   * and manages Support. In Support: Erik and Bob, plain members, and Gina,
   * a group admin. Dana is a delegated org admin.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const erik = await makeUser("Erik Worker");
    const bob = await makeUser("Bob Plain");
    const gina = await makeUser("Gina Groupadmin");
    const dana = await makeUser("Dana Delegate");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await upsertAttendanceSettings(organizationId, {
      ...ATTENDANCE_SETTINGS_DEFAULTS,
      balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
      attendanceEnabled: true,
      timezone: ZONE,
      selfServiceEnabled: true,
      selfServiceDays: 7,
    });

    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id, { adminAccess: true, approverAccess: true });
    await addMember(support, erik.id);
    await addMember(support, bob.id);
    await addMember(support, gina.id, { adminAccess: true });
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    for (const person of [owner, erik, bob, gina, dana]) {
      await syncEmployment(organizationId, person.id);
    }
    await db
      .update(employments)
      .set({ startedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(employments.organizationId, organizationId));

    await enableEnterpriseDirectory(organizationId, owner.id);

    return { organizationId, support, users: { owner, erik, bob, gina, dana } };
  };

  const as = (userId: string) => apiAs(server.url, userId);

  const employmentOf = async (organizationId: string, userId: string) => {
    const [row] = await db
      .select()
      .from(employments)
      .where(
        and(
          eq(employments.organizationId, organizationId),
          eq(employments.userId, userId),
          isNull(employments.endedAt)
        )
      );
    return row!;
  };

  const profilePath = (organizationId: string, employmentId: string) =>
    `/api/directory/${organizationId}/people/${employmentId}`;
  const typePath = (organizationId: string, employmentId: string) =>
    `${profilePath(organizationId, employmentId)}/worker-type`;

  const historyOf = (employmentId: string) =>
    db
      .select({
        section: directoryProfileHistory.section,
        fields: directoryProfileHistory.fields,
        audience: directoryProfileHistory.audience,
        actorUserId: directoryProfileHistory.actorUserId,
      })
      .from(directoryProfileHistory)
      .where(eq(directoryProfileHistory.employmentId, employmentId))
      .orderBy(asc(directoryProfileHistory.createdAt), asc(directoryProfileHistory.section));

  /** Fills Erik's Job and Personal sections as the owner. */
  const fillErik = async (world: Awaited<ReturnType<typeof setUp>>) => {
    const erik = await employmentOf(world.organizationId, world.users.erik.id);
    const owner = await as(world.users.owner.id);
    await owner
      .patch(profilePath(world.organizationId, erik.id), {
        job: {
          legalName: "Erik Worker Senior",
          startDate: "2024-01-01",
          probationEndDate: "2024-04-01",
          contractType: "PERMANENT",
          workingTime: "FULL_TIME",
        },
        personal: PERSONAL,
      })
      .expect(200);
    await db.delete(directoryProfileHistory);
    return erik;
  };

  const setCell = async (organizationId: string, row: string, audience: string, value: string) =>
    db
      .update(directoryPermissionCells)
      .set({ value: value as never })
      .where(
        and(
          eq(directoryPermissionCells.organizationId, organizationId),
          eq(directoryPermissionCells.row, row as never),
          eq(directoryPermissionCells.audience, audience as never)
        )
      );

  describe("changing to External worker", () => {
    it("clears the employee-only Job fields and Personal in one go and records them", async () => {
      const world = await setUp();
      const erik = await fillErik(world);

      const res = await (
        await as(world.users.dana.id)
      )
        .put(typePath(world.organizationId, erik.id), { type: "external" })
        .expect(200);

      expect(res.body.markers).toContain("EXTERNAL_WORKER");
      expect(res.body.sections.personal).toBeUndefined();
      expect(res.body.sections.job).toMatchObject({
        legalName: "Erik Worker Senior",
        startDate: "2024-01-01",
        probationEndDate: null,
        contractType: null,
        workingTime: null,
      });

      expect((await employmentOf(world.organizationId, world.users.erik.id)).type).toBe("external");
      const [sealed] = await db
        .select()
        .from(directorySensitiveProfiles)
        .where(eq(directorySensitiveProfiles.employmentId, erik.id));
      expect(sealed?.personal).toBeNull();
      const [stored] = await db
        .select()
        .from(directoryProfiles)
        .where(eq(directoryProfiles.employmentId, erik.id));
      expect(stored).toMatchObject({
        legalName: "Erik Worker Senior",
        probationEndDate: null,
        contractType: null,
        workingTime: null,
      });

      const history = await historyOf(erik.id);
      expect(history).toEqual(
        expect.arrayContaining([
          {
            section: "JOB",
            fields: ["probationEndDate", "contractType", "workingTime"],
            audience: "ORGANIZATION_ADMIN",
            actorUserId: world.users.dana.id,
          },
          {
            section: "PERSONAL",
            fields: ["homeAddress", "dateOfBirth"],
            audience: "ORGANIZATION_ADMIN",
            actorUserId: world.users.dana.id,
          },
          {
            section: "CHANGE_WORKER_TYPE",
            fields: ["type"],
            audience: "ORGANIZATION_ADMIN",
            actorUserId: world.users.dana.id,
          },
        ])
      );
      expect(history).toHaveLength(3);
    });
    it("starts nothing again on the way back to employee", async () => {
      const world = await setUp();
      const erik = await fillErik(world);
      const owner = await as(world.users.owner.id);
      await owner.put(typePath(world.organizationId, erik.id), { type: "external" }).expect(200);
      await db.delete(directoryProfileHistory);

      const res = await owner
        .put(typePath(world.organizationId, erik.id), { type: "employee" })
        .expect(200);

      expect(res.body.markers).not.toContain("EXTERNAL_WORKER");
      expect(res.body.sections.personal).toEqual({ level: "WRITE" });
      expect(res.body.sections.job).toMatchObject({ contractType: null, workingTime: null });
      const shown = await owner
        .post(`${profilePath(world.organizationId, erik.id)}/show/personal`)
        .expect(200);
      expect(shown.body).toMatchObject({ homeAddress: null, dateOfBirth: null });
      expect(await historyOf(erik.id)).toEqual([
        {
          section: "CHANGE_WORKER_TYPE",
          fields: ["type"],
          audience: "OWNER",
          actorUserId: world.users.owner.id,
        },
      ]);
    });

    it("changes nothing when the record already has the type", async () => {
      const world = await setUp();
      const erik = await fillErik(world);

      const res = await (
        await as(world.users.owner.id)
      )
        .put(typePath(world.organizationId, erik.id), { type: "employee" })
        .expect(200);

      expect(res.body.sections.job.contractType).toBe("PERMANENT");
      expect(await historyOf(erik.id)).toEqual([]);
    });

    it("works on a record without an account", async () => {
      const world = await setUp();
      const created = await (
        await as(world.users.owner.id)
      )
        .post(`/api/directory/${world.organizationId}/people`, { name: "Ada Accountless" })
        .expect(201);

      const res = await (
        await as(world.users.owner.id)
      )
        .put(typePath(world.organizationId, created.body.employmentId), { type: "external" })
        .expect(200);

      expect(res.body.markers).toEqual(expect.arrayContaining(["EXTERNAL_WORKER", "NO_ACCOUNT"]));
    });
  });

  describe("who may change it", () => {
    it("refuses a colleague and a group admin without the act, and stores nothing", async () => {
      const world = await setUp();
      const erik = await fillErik(world);

      for (const userId of [world.users.bob.id, world.users.gina.id]) {
        const res = await (
          await as(userId)
        ).put(typePath(world.organizationId, erik.id), {
          type: "external",
        });
        expect(res.status).toBe(403);
        expect(code(res)).toBe("WORKER_TYPE_DENIED");
      }
      expect((await employmentOf(world.organizationId, world.users.erik.id)).type).toBe("employee");
      expect(await historyOf(erik.id)).toEqual([]);
    });

    it("follows the stored cell: a group admin given the act may change a member in reach", async () => {
      const world = await setUp();
      const erik = await fillErik(world);
      await setCell(world.organizationId, "CHANGE_WORKER_TYPE", "GROUP_ADMIN", "ALLOWED");

      await (
        await as(world.users.gina.id)
      )
        .put(typePath(world.organizationId, erik.id), { type: "external" })
        .expect(200);

      expect((await historyOf(erik.id)).map((row) => row.audience)).toEqual([
        "GROUP_ADMIN",
        "GROUP_ADMIN",
        "GROUP_ADMIN",
      ]);
    });

    it("lets the act through on a lapsed plan", async () => {
      const world = await setUp();
      const erik = await employmentOf(world.organizationId, world.users.erik.id);
      await upsertSubscription(world.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });

      await (
        await as(world.users.owner.id)
      )
        .put(typePath(world.organizationId, erik.id), { type: "external" })
        .expect(200);
    });

    it("waits for the directory, and refuses an ended record", async () => {
      const world = await setUp();
      const erik = await employmentOf(world.organizationId, world.users.erik.id);
      const owner = await as(world.users.owner.id);

      await owner.post(`/api/employment/${erik.id}/end`, { endedOn: "2026-01-02" }).expect(200);
      const ended = await owner.put(typePath(world.organizationId, erik.id), { type: "external" });
      expect(ended.status).toBe(409);
      expect(code(ended)).toBe("EMPLOYMENT_ENDED");

      const bob = await employmentOf(world.organizationId, world.users.bob.id);
      await db.transaction((tx) =>
        disableDirectory({ organizationId: world.organizationId, userId: world.users.owner.id }, tx)
      );
      const off = await owner.put(typePath(world.organizationId, bob.id), { type: "external" });
      expect(off.status).toBe(409);
      expect(code(off)).toBe("DIRECTORY_OFF");
    });

    it("offers the action on the profile only to holders of the act, on open records", async () => {
      const world = await setUp();
      const erik = await employmentOf(world.organizationId, world.users.erik.id);

      const asOwner = await (
        await as(world.users.owner.id)
      )
        .get(profilePath(world.organizationId, erik.id))
        .expect(200);
      const asBob = await (
        await as(world.users.bob.id)
      )
        .get(profilePath(world.organizationId, erik.id))
        .expect(200);

      expect(asOwner.body.actions.changeType).toBe(true);
      expect(asBob.body.actions.changeType).toBe(false);
    });
  });
  describe("an External worker's attendance", () => {
    const makeExternal = async (world: Awaited<ReturnType<typeof setUp>>, userId: string) => {
      const employment = await employmentOf(world.organizationId, userId);
      await (
        await as(world.users.owner.id)
      )
        .put(typePath(world.organizationId, employment.id), { type: "external" })
        .expect(200);
      return employment;
    };
    const yesterday = () => {
      const day = businessDateInZone(new Date(Date.now() - 24 * 60 * 60 * 1000), ZONE);
      return {
        businessDate: day,
        startedAt: new Date(`${day}T07:00:00Z`).toISOString(),
        endedAt: new Date(`${day}T11:00:00Z`).toISOString(),
      };
    };

    it("shows no clock and refuses clocking in", async () => {
      const world = await setUp();
      await makeExternal(world, world.users.erik.id);
      const erik = await as(world.users.erik.id);

      const state = await erik
        .get(`/api/attendance/current?organizationId=${world.organizationId}`)
        .expect(200);
      expect(state.body).toMatchObject({ active: false, externalWorker: true });

      const res = await erik.post("/api/attendance/clock-in", {
        organizationId: world.organizationId,
      });
      expect(res.status).toBe(403);
      expect(res.body.errors[0].context.reason).toBe("EXTERNAL_WORKER");

      const bob = await (
        await as(world.users.bob.id)
      )
        .get(`/api/attendance/current?organizationId=${world.organizationId}`)
        .expect(200);
      expect(bob.body).toMatchObject({ active: true, externalWorker: false });
    });

    it("lets a session open before the change be closed, and opens no break on it", async () => {
      const world = await setUp();
      const erik = await as(world.users.erik.id);
      await erik
        .post("/api/attendance/clock-in", { organizationId: world.organizationId })
        .expect(201);
      await makeExternal(world, world.users.erik.id);

      const onBreak = await erik.post("/api/attendance/break/start", {
        organizationId: world.organizationId,
      });
      expect(onBreak.status).toBe(403);
      await erik
        .post("/api/attendance/clock-out", { organizationId: world.organizationId })
        .expect(200);
    });

    it("refuses an entered session, whoever enters it", async () => {
      const world = await setUp();
      await makeExternal(world, world.users.erik.id);

      for (const [callerId, body] of [
        [world.users.erik.id, {}],
        [world.users.owner.id, { userId: world.users.erik.id }],
      ] as const) {
        const res = await (
          await as(callerId)
        ).post("/api/attendance/sessions", {
          organizationId: world.organizationId,
          ...body,
          ...yesterday(),
        });
        expect(res.status).toBe(403);
        expect(res.body.errors[0].context.reason).toBe("EXTERNAL_WORKER");
      }
    });

    it("owes no required time in the month", async () => {
      const world = await setUp();
      await makeExternal(world, world.users.erik.id);
      const [year, month] = businessDateInZone(new Date(), ZONE).split("-").map(Number);

      const res = await (
        await as(world.users.erik.id)
      )
        .get(
          `/api/attendance/month?organizationId=${world.organizationId}&year=${year!}&month=${month!}`
        )
        .expect(200);

      expect(res.body.requiredMinutesPerDay).toBe(0);
      expect(res.body.totals.requiredRangeMinutes).toBe(0);
      expect(
        res.body.days.every((day: { requiredMinutes: number }) => day.requiredMinutes === 0)
      ).toBe(true);
    });

    it("is left out of Team attendance", async () => {
      const world = await setUp();
      await makeExternal(world, world.users.erik.id);
      const today = businessDateInZone(new Date(), ZONE);

      const res = await (
        await as(world.users.owner.id)
      )
        .get(
          `/api/attendance/team?organizationId=${world.organizationId}&from=${today}&to=${today}`
        )
        .expect(200);

      const ids = res.body.people.map((person: { userId: string }) => person.userId);
      expect(ids).toContain(world.users.bob.id);
      expect(ids).not.toContain(world.users.erik.id);
    });

    it("drops the required-time override and refuses a new one", async () => {
      const world = await setUp();
      const before = await employmentOf(world.organizationId, world.users.erik.id);
      const owner = await as(world.users.owner.id);
      await owner.patch(`/api/employment/${before.id}`, { requiredMinutesPerDay: 240 }).expect(200);

      await makeExternal(world, world.users.erik.id);
      expect(
        (await employmentOf(world.organizationId, world.users.erik.id)).requiredMinutesPerDay
      ).toBeNull();

      const res = await owner.patch(`/api/employment/${before.id}`, { requiredMinutesPerDay: 240 });
      expect(res.status).toBe(403);
      expect(res.body.errors[0].context.reason).toBe("EXTERNAL_WORKER");
      await owner
        .patch(`/api/employment/${before.id}`, { requiredMinutesPerDay: null })
        .expect(200);
    });
  });
  describe("an External worker's allowances and bookings", () => {
    const makeExternal = async (world: Awaited<ReturnType<typeof setUp>>, userId: string) => {
      const employment = await employmentOf(world.organizationId, userId);
      await (
        await as(world.users.owner.id)
      )
        .put(typePath(world.organizationId, employment.id), { type: "external" })
        .expect(200);
      return employment;
    };
    /** A Wednesday at least a week ahead, a working day in a group with no holiday country. */
    const aWorkingDay = () => {
      const day = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      day.setUTCDate(day.getUTCDate() + ((3 - day.getUTCDay() + 7) % 7));
      return day.toISOString().slice(0, 10);
    };
    const quotasOf = (userId: string, groupId: string) =>
      db
        .select({
          relatedYear: userYearQuotas.relatedYear,
          vacationDays: userYearQuotas.vacationDays,
          homeOfficeDays: userYearQuotas.homeOfficeDays,
          sickDays: userYearQuotas.sickDays,
          carriedOverDays: userYearQuotas.carriedOverDays,
        })
        .from(userYearQuotas)
        .where(and(eq(userYearQuotas.userId, userId), eq(userYearQuotas.groupId, groupId)))
        .orderBy(asc(userYearQuotas.relatedYear));
    const thisYear = () => Number(businessDateInZone(new Date(), ZONE).slice(0, 4));

    it("sets the allowance to zero from this year on and leaves earlier years", async () => {
      const world = await setUp();
      const year = thisYear();
      await addQuota(world.support, world.users.erik.id, year - 1, { vacationDays: 25 });
      await addQuota(world.support, world.users.erik.id, year + 1, {
        vacationDays: 25,
        carriedOverDays: 3,
      });

      await makeExternal(world, world.users.erik.id);

      const zero = { vacationDays: 0, homeOfficeDays: 0, sickDays: 0, carriedOverDays: 0 };
      expect(await quotasOf(world.users.erik.id, world.support)).toEqual([
        { relatedYear: String(year - 1), ...zero, vacationDays: 25 },
        { relatedYear: String(year), ...zero },
        { relatedYear: String(year + 1), ...zero },
      ]);
      const balances = await (
        await as(world.users.erik.id)
      )
        .get(`/api/users/me/balances?year=${year}`)
        .expect(200);
      expect(
        balances.body.buckets.map((bucket: { allocated: number }) => bucket.allocated)
      ).toEqual([0, 0]);
    });

    it("opens next year at zero in the rollover, even after an admin raised this year's", async () => {
      const world = await setUp();
      const year = thisYear();
      await makeExternal(world, world.users.erik.id);
      await db
        .update(userYearQuotas)
        .set({ vacationDays: 10 })
        .where(eq(userYearQuotas.userId, world.users.erik.id));

      await rolloverQuotasForYear(year + 1);

      const next = async (userId: string) =>
        (await quotasOf(userId, world.support)).find((row) => row.relatedYear === String(year + 1));
      expect(await next(world.users.erik.id)).toMatchObject({
        vacationDays: 0,
        carriedOverDays: 0,
      });
      expect((await next(world.users.bob.id))?.vacationDays).toBe(20);
    });

    it("opens a group joined later at zero", async () => {
      const world = await setUp();
      const joiner = await makeUser("Petra Joiner");
      const email = `${joiner.id.toLowerCase()}@report-e2e.test`;
      const owner = await as(world.users.owner.id);
      await owner
        .post(`/api/directory/${world.organizationId}/people`, {
          name: "Petra Nová",
          type: "external",
          email,
        })
        .expect(201);
      const invite = await owner
        .post(`/api/group-user/${world.support}/invites`, { email })
        .expect(201);

      await (
        await as(joiner.id)
      )
        .post(`/api/group-user/code/${invite.body.invite.code as string}`, {})
        .expect(201);

      expect(await quotasOf(joiner.id, world.support)).toEqual([
        {
          relatedYear: String(new Date().getUTCFullYear()),
          vacationDays: 0,
          homeOfficeDays: 0,
          sickDays: 0,
          carriedOverDays: 0,
        },
      ]);
    });

    it("refuses a booking that draws on an allowance, whatever the stored quota, and takes the rest", async () => {
      const world = await setUp();
      await makeExternal(world, world.users.erik.id);
      await db
        .update(userYearQuotas)
        .set({ vacationDays: 10, homeOfficeDays: 10 })
        .where(eq(userYearQuotas.userId, world.users.erik.id));
      const erik = await as(world.users.erik.id);
      const day = aWorkingDay();

      for (const vacationType of ["VACATION", "HOME_OFFICE"]) {
        const res = await erik.post("/api/vacation/create-vacation", {
          groupId: world.support,
          from: day,
          to: day,
          vacationType,
        });
        expect(res.status).toBe(422);
        expect(code(res)).toBe("EXTERNAL_WORKER_ALLOWANCE");
      }
      await erik
        .post("/api/vacation/create-vacation", {
          groupId: world.support,
          from: day,
          to: day,
          vacationType: "NON_PAID_LEAVE",
        })
        .expect(201);

      const onBehalf = await (
        await as(world.users.owner.id)
      ).post("/api/vacation/create-vacation", {
        groupId: world.support,
        userId: world.users.erik.id,
        from: aWorkingDay(),
        to: aWorkingDay(),
      });
      expect(onBehalf.status).toBe(422);
      expect(code(onBehalf)).toBe("EXTERNAL_WORKER_ALLOWANCE");
    });

    it("refuses approving an allowance-drawing request made before the change", async () => {
      const world = await setUp();
      const pending = await addLeave(world.support, world.users.erik.id, aWorkingDay(), {
        approved: false,
      });
      await makeExternal(world, world.users.erik.id);

      const res = await (await as(world.users.owner.id)).post(`/api/vacation/approve/${pending}`);

      expect(res.status).toBe(422);
      expect(code(res)).toBe("EXTERNAL_WORKER_ALLOWANCE");
    });

    it("leaves an employee's bookings alone", async () => {
      const world = await setUp();
      const day = aWorkingDay();

      await (
        await as(world.users.bob.id)
      )
        .post("/api/vacation/create-vacation", { groupId: world.support, from: day, to: day })
        .expect(201);
    });
  });
  describe("the External worker badge and column", () => {
    it("shows the badge to every viewer, on the list and the profile", async () => {
      const world = await setUp();
      const erik = await employmentOf(world.organizationId, world.users.erik.id);
      await (
        await as(world.users.owner.id)
      )
        .put(typePath(world.organizationId, erik.id), { type: "external" })
        .expect(200);

      const { owner, bob, gina, dana } = world.users;
      for (const viewer of [owner, bob, gina, dana, world.users.erik]) {
        const client = await as(viewer.id);
        const list = await client.get(`/api/directory/${world.organizationId}/people`).expect(200);
        const row = list.body.people.find(
          (person: { employmentId: string }) => person.employmentId === erik.id
        );
        expect(row.markers).toContain("EXTERNAL_WORKER");
        const profile = await client.get(profilePath(world.organizationId, erik.id)).expect(200);
        expect(profile.body.markers).toContain("EXTERNAL_WORKER");
      }
    });

    it("lets an External worker read colleagues through the External worker column", async () => {
      const world = await setUp();
      const erik = await employmentOf(world.organizationId, world.users.erik.id);
      const bob = await employmentOf(world.organizationId, world.users.bob.id);
      const reader = await as(world.users.bob.id);
      const before = await reader.get(profilePath(world.organizationId, erik.id)).expect(200);
      expect(before.body.sections.workContact).toBeDefined();

      await (
        await as(world.users.owner.id)
      )
        .put(typePath(world.organizationId, bob.id), { type: "external" })
        .expect(200);

      const after = await reader.get(profilePath(world.organizationId, erik.id)).expect(200);
      expect(after.body.sections.card).toBeDefined();
      expect(after.body.sections.workContact).toBeUndefined();
    });
  });
});
