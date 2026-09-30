import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { attendanceSessions } from "../../db/schema/attendance-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  organizationAttendanceSettings,
  type balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { countQueries } from "./helpers/queryCounter.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";
import { getEmployment, syncEmployment } from "../../services/employment/employmentServices.js";
import { canAdministerEmployment } from "../../services/employment/attendanceAccess.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";

const ZONE = "Europe/Prague";

type Person = { id: string };

const switchOn = (organizationId: string) =>
  upsertAttendanceSettings(organizationId, {
    ...ATTENDANCE_SETTINGS_DEFAULTS,
    balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
    attendanceEnabled: true,
    timezone: ZONE,
  });

const onPro = (organizationId: string) =>
  upsertSubscription(organizationId, {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });

/** better-auth reading the session and user behind the cookie, as on every route. */
const handlerQueries = (queries: string[]) =>
  queries.filter((query) => !/ from "(session|user)" /.test(query));

const PURPOSES: [string, RegExp][] = [
  ["subject", /from "employments" left join "organization_attendance_settings"/],
  ["org owner", /from "organizations" where/],
  ["org admin grant", /from "organization_users" where/],
  ["group standing", /from "group_users" inner join "groups"/],
  ["today's sessions", /from "attendance_sessions" where .*"business_date" = /s],
  ["open session", /from "attendance_sessions" where .*"attendance_sessions"."ended_at" is null/s],
  ["auto-closed session", /from "attendance_sessions" where .*"business_date" in \(/s],
  ["breaks", /from "attendance_breaks" where/],
];

/** What each query was for, sorted: reads that run side by side arrive in any order. */
const purposes = (queries: string[]) =>
  queries.map((query) => PURPOSES.find(([, pattern]) => pattern.test(query))?.[0] ?? query).sort();

const settingsReads = (queries: string[]) =>
  queries.filter((query) => query.includes('"organization_attendance_settings"')).length;

describe("the round trips behind GET /api/attendance/current", () => {
  let app: Express;
  let server: LoopbackServer;
  let ORGANIZATION_ID: string;
  let engineeringId: string;

  let owner: Person;
  let delegate: Person;
  let groupAdmin: Person;
  let member: Person;
  let manager: Person;
  let salesMember: Person;

  const cookies = new Map<string, string>();
  const cookieOf = (person: Person) => cookies.get(person.id)!;

  const current = async (person: Person) => {
    const { result, queries } = await countQueries(app, (url) =>
      request(url).get("/api/attendance/current").set("Cookie", cookieOf(person)).expect(200)
    );
    return { result, queries: handlerQueries(queries) };
  };

  const addToGroup = (person: Person, groupId: string, adminAccess = false) =>
    db.insert(groupUsers).values({
      id: uuidv4(),
      userId: person.id,
      groupId,
      viewAccess: true,
      adminAccess,
      approverAccess: false,
      controlledUser: !adminAccess,
    });

  const createGroup = async (organizationId: string, managerUserId: string, groupName: string) => {
    const id = uuidv4();
    await db.insert(groups).values({
      id,
      organizationId,
      groupName,
      managerUserId,
      mainApprovalUser: managerUserId,
    });
    return id;
  };

  const person = async (email: string, name: string) => {
    const created = await createTestUser(email, name, "password123");
    cookies.set(created.id, await authCookieFor(created.id));
    return { id: created.id };
  };

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();
    server = await listenOnLoopback(app);

    owner = await person("rt-owner@test.com", "Olivia Owner");
    delegate = await person("rt-delegate@test.com", "Dora Delegate");
    groupAdmin = await person("rt-group-admin@test.com", "Greta Admin");
    member = await person("rt-member@test.com", "Milo Member");
    manager = await person("rt-manager@test.com", "Max Manager");
    salesMember = await person("rt-sales-member@test.com", "Sam Sales");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;
    engineeringId = await createGroup(ORGANIZATION_ID, owner.id, "Engineering");
    // Managed without a membership row, so no group of the organization holds them.
    const salesId = await createGroup(ORGANIZATION_ID, manager.id, "Sales");

    await addToGroup(delegate, engineeringId);
    await addToGroup(groupAdmin, engineeringId, true);
    await addToGroup(member, engineeringId);
    await addToGroup(salesMember, salesId);

    for (const each of [delegate, groupAdmin, member, manager, salesMember]) {
      await syncEmployment(ORGANIZATION_ID, each.id);
    }
    await grantOrganizationAdmin({
      organizationId: ORGANIZATION_ID,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  describe("in an organization that never set attendance up", () => {
    beforeEach(async () => {
      await db
        .delete(organizationAttendanceSettings)
        .where(eq(organizationAttendanceSettings.organizationId, ORGANIZATION_ID));
    });

    it("answers a member with one Employment in four queries, one of them the settings", async () => {
      const { result, queries } = await current(member);

      expect(result.body).toMatchObject({
        organizationId: ORGANIZATION_ID,
        active: false,
        timezone: null,
        administersOwnAttendance: false,
      });
      // No timezone, so no day to read: the subject, then administersOwnAttendance.
      expect(purposes(queries)).toEqual(
        ["subject", "org owner", "org admin grant", "group standing"].sort()
      );
      expect(settingsReads(queries)).toBe(1);
    });

    it("reports who administers their own attendance", async () => {
      const standing = async (person: Person) =>
        (await current(person)).result.body.administersOwnAttendance as boolean;

      expect(await standing(owner)).toBe(true);
      expect(await standing(delegate)).toBe(true);
      expect(await standing(groupAdmin)).toBe(true);
      expect(await standing(member)).toBe(false);
      expect(await standing(manager)).toBe(false);
    });

    it("credits a manager with no membership row over the members of their own group only", async () => {
      const employmentOf = async (person: Person) =>
        (await getEmployment(ORGANIZATION_ID, person.id))!;

      expect(await canAdministerEmployment(manager.id, await employmentOf(member))).toBe(false);
      expect(await canAdministerEmployment(manager.id, await employmentOf(salesMember))).toBe(true);
    });
  });

  describe("for a member clocked in with a break running", () => {
    beforeAll(async () => {
      await switchOn(ORGANIZATION_ID);
      await onPro(ORGANIZATION_ID);
      await request(server.url)
        .post("/api/attendance/clock-in")
        .set("Cookie", cookieOf(member))
        .expect(201);
      await request(server.url)
        .post("/api/attendance/break/start")
        .set("Cookie", cookieOf(member))
        .expect(201);
    });

    afterAll(async () => {
      await db.delete(attendanceSessions);
    });

    it("answers in eight queries, one of them the settings", async () => {
      const { result, queries } = await current(member);

      expect(result.body).toMatchObject({
        organizationId: ORGANIZATION_ID,
        active: true,
        timezone: ZONE,
        administersOwnAttendance: false,
      });
      expect(result.body.openSession).not.toBeNull();
      expect(result.body.openBreak).not.toBeNull();
      expect(result.body.openBreak.sessionId).toBe(result.body.openSession.id);
      expect(result.body.sessions).toHaveLength(1);
      expect(purposes(queries)).toEqual(
        [
          "subject",
          "org owner",
          "org admin grant",
          "group standing",
          "today's sessions",
          // The open break is read from these, not asked for again.
          "breaks",
          "open session",
          "auto-closed session",
        ].sort()
      );
      expect(settingsReads(queries)).toBe(1);
    });
  });

  describe("picking the Employment when no organization is named", () => {
    let roamer: Person;
    const organizations: string[] = [];

    const employ = async (index: number) => {
      const founder = await person(`rt-founder-${index}@test.com`, `Founder ${index}`);
      const organizationId = (await ensureOrganizationForUser(founder.id)).id;
      await addToGroup(roamer, await createGroup(organizationId, founder.id, `Team ${index}`));
      await syncEmployment(organizationId, roamer.id);
      organizations.push(organizationId);
    };

    const setEnded = (organizationId: string, endedAt: Date | null) =>
      db
        .update(employments)
        .set({ endedAt })
        .where(
          and(eq(employments.organizationId, organizationId), eq(employments.userId, roamer.id))
        );

    beforeAll(async () => {
      roamer = await person("rt-roamer@test.com", "Rita Roamer");
    });

    it("costs the same with one, two and three live Employments", async () => {
      const counts: number[] = [];
      for (const index of [1, 2, 3]) {
        await employ(index);
        // Switched on but on Free, so each later organization is a candidate that loses.
        if (index > 1) await switchOn(organizations[index - 1]!);

        const { result, queries } = await current(roamer);
        expect(result.body.organizationId).toBe(organizations[0]);
        counts.push(queries.length);
      }

      expect(counts[1]).toBe(counts[0]);
      expect(counts[2]).toBe(counts[0]);
    });

    it("takes the first live Employment whose organization has attendance active", async () => {
      await onPro(organizations[2]!);

      expect((await current(roamer)).result.body).toMatchObject({
        organizationId: organizations[2],
        active: true,
      });
    });

    it("counts ended Employments only when none is live", async () => {
      await setEnded(organizations[2]!, new Date());
      expect((await current(roamer)).result.body.organizationId).toBe(organizations[0]);

      await setEnded(organizations[0]!, new Date());
      await setEnded(organizations[1]!, new Date());
      expect((await current(roamer)).result.body).toMatchObject({
        organizationId: organizations[2],
        employmentEnded: true,
        active: true,
      });
    });
  });
});
