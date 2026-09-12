import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationAttendanceSettings } from "../../db/schema/organization-attendance-settings-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const proActive = () =>
  upsertSubscription(ORGANIZATION_ID, {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });

const proLapsed = () =>
  upsertSubscription(ORGANIZATION_ID, {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Canceled,
    graceEndsAt: new Date(Date.now() - DAY_MS),
  });

const free = () =>
  upsertSubscription(ORGANIZATION_ID, {
    plan: null,
    status: null,
    graceEndsAt: null,
  });

let ORGANIZATION_ID: string;

describe("organization attendance settings", () => {
  let app: Express;

  let owner: { id: string };
  /** Org admin who belongs to no group — the delegate path. */
  let delegate: { id: string };
  /** Manages the group, administers nothing at the organization. */
  let manager: { id: string };
  let member: { id: string };

  let ownerCookie: string;
  let delegateCookie: string;
  let managerCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    owner = await createTestUser("att-owner@test.com", "Olivia Owner", "password123");
    delegate = await createTestUser("att-delegate@test.com", "Dana Delegate", "password123");
    manager = await createTestUser("att-manager@test.com", "Mara Manager", "password123");
    member = await createTestUser("att-member@test.com", "Milo Member", "password123");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    const groupId = uuidv4();
    await db.insert(groups).values({
      id: groupId,
      organizationId: ORGANIZATION_ID,
      groupName: "Engineering",
      managerUserId: manager.id,
      mainApprovalUser: manager.id,
    });

    await db.insert(groupUsers).values([
      {
        id: uuidv4(),
        userId: manager.id,
        groupId,
        viewAccess: true,
        adminAccess: true,
        approverAccess: true,
        controlledUser: true,
      },
      {
        id: uuidv4(),
        userId: member.id,
        groupId,
        viewAccess: true,
        adminAccess: false,
        approverAccess: false,
        controlledUser: true,
      },
    ]);

    await grantOrganizationAdmin({
      organizationId: ORGANIZATION_ID,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });

    ownerCookie = await authCookieFor(owner.id);
    delegateCookie = await authCookieFor(delegate.id);
    managerCookie = await authCookieFor(manager.id);
    memberCookie = await authCookieFor(member.id);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(organizationAttendanceSettings);
    await free();
  });

  describe("get", () => {
    it("answers the defaults with the feature off when nothing was ever saved", async () => {
      const res = await request(app)
        .get("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .expect(200);

      expect(res.body).toMatchObject({
        organizationId: ORGANIZATION_ID,
        attendanceEnabled: false,
        locationEnabled: false,
        timezone: null,
        holidayCountry: null,
        workingDays: [1, 2, 3, 4, 5],
        breakMinutes: 30,
        breakThresholdMinutes: 360,
        requiredMinutesPerDay: 480,
        balanceMode: "DAILY",
        sessionCeilingMinutes: 960,
        breakCeilingMinutes: 120,
        active: false,
      });
    });

    it("is readable by a delegated admin", async () => {
      await request(app)
        .get("/api/organization/attendance-settings")
        .set("Cookie", delegateCookie)
        .expect(200);
    });

    it("403s for a group manager and for a member", async () => {
      // Named explicitly: neither administers an organization, so an unscoped
      // request has none to default to and 404s before the permission check.
      await request(app)
        .get(`/api/organization/attendance-settings?organizationId=${ORGANIZATION_ID}`)
        .set("Cookie", managerCookie)
        .expect(403);

      await request(app)
        .get(`/api/organization/attendance-settings?organizationId=${ORGANIZATION_ID}`)
        .set("Cookie", memberCookie)
        .expect(403);
    });
  });

  describe("put", () => {
    it("writes the defaults for every rule the body omits", async () => {
      await proActive();

      const res = await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague" })
        .expect(200);

      expect(res.body).toMatchObject({
        attendanceEnabled: true,
        timezone: "Europe/Prague",
        locationEnabled: false,
        workingDays: [1, 2, 3, 4, 5],
        breakMinutes: 30,
        breakThresholdMinutes: 360,
        requiredMinutesPerDay: 480,
        balanceMode: "DAILY",
        sessionCeilingMinutes: 960,
        breakCeilingMinutes: 120,
        active: true,
      });

      const reread = await request(app)
        .get("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .expect(200);
      expect(reread.body).toEqual(res.body);
    });

    it("succeeds as a delegated admin", async () => {
      await proActive();

      const res = await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", delegateCookie)
        .send({
          attendanceEnabled: true,
          timezone: "Europe/Prague",
          holidayCountry: "cz",
          locationEnabled: true,
          workingDays: [5, 1, 1, 2, 3, 4],
          breakMinutes: 45,
          balanceMode: "MONTHLY",
        })
        .expect(200);

      expect(res.body).toMatchObject({
        attendanceEnabled: true,
        locationEnabled: true,
        // Upper-cased and de-duplicated on the way in.
        holidayCountry: "CZ",
        workingDays: [1, 2, 3, 4, 5],
        breakMinutes: 45,
        balanceMode: "MONTHLY",
        active: true,
      });
    });

    it("403s for a group manager and for a member", async () => {
      await proActive();

      await request(app)
        .put(`/api/organization/attendance-settings?organizationId=${ORGANIZATION_ID}`)
        .set("Cookie", managerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague" })
        .expect(403);

      await request(app)
        .put(`/api/organization/attendance-settings?organizationId=${ORGANIZATION_ID}`)
        .set("Cookie", memberCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague" })
        .expect(403);
    });

    it("422s when enabling without a timezone", async () => {
      await proActive();

      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true })
        .expect(422);

      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: null })
        .expect(422);
    });

    it("422s on an unknown timezone and an unsupported holiday country", async () => {
      await proActive();

      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Mars/Olympus_Mons" })
        .expect(422);

      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague", holidayCountry: "ZZ" })
        .expect(422);
    });

    it("keeps a timezone-less body legal while attendance stays off", async () => {
      const res = await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: false, breakMinutes: 15 })
        .expect(200);

      expect(res.body).toMatchObject({
        attendanceEnabled: false,
        timezone: null,
        breakMinutes: 15,
        active: false,
      });
    });

    it("402s when enabling on Free, and writes nothing", async () => {
      const res = await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague" })
        .expect(402);

      expect(res.body.errors).toEqual([
        expect.objectContaining({ context: { reason: "PLAN_LIMIT" } }),
      ]);

      // The guard runs inside the write's transaction, so the refusal rolls the
      // row back rather than leaving attendance stored-on-but-inactive.
      const reread = await request(app)
        .get("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .expect(200);
      expect(reread.body).toMatchObject({ attendanceEnabled: false, timezone: null });
    });

    it("402s when enabling on a Pro subscription whose grace has expired", async () => {
      await proLapsed();

      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague" })
        .expect(402);
    });

    it("never gates turning attendance off", async () => {
      await proActive();
      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague" })
        .expect(200);

      await proLapsed();

      const res = await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: false, timezone: "Europe/Prague" })
        .expect(200);
      expect(res.body).toMatchObject({ attendanceEnabled: false, active: false });
    });
  });

  describe("when a Pro organization lapses", () => {
    it("keeps the row readable and reports attendance inactive", async () => {
      await proActive();
      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague", requiredMinutesPerDay: 450 })
        .expect(200);

      await proLapsed();

      const res = await request(app)
        .get("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .expect(200);

      // Dormant, not deleted: the toggle and every rule survive the lapse.
      expect(res.body).toMatchObject({
        attendanceEnabled: true,
        requiredMinutesPerDay: 450,
        timezone: "Europe/Prague",
        active: false,
      });
    });

    it("lets a lapsed organization still correct its rules", async () => {
      await proActive();
      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague" })
        .expect(200);

      await proLapsed();

      const res = await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Berlin", breakMinutes: 60 })
        .expect(200);

      expect(res.body).toMatchObject({
        timezone: "Europe/Berlin",
        breakMinutes: 60,
        active: false,
      });
    });

    it("goes active again when the subscription comes back", async () => {
      await proActive();
      await request(app)
        .put("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .send({ attendanceEnabled: true, timezone: "Europe/Prague" })
        .expect(200);

      await proLapsed();
      await proActive();

      const res = await request(app)
        .get("/api/organization/attendance-settings")
        .set("Cookie", ownerCookie)
        .expect(200);
      expect(res.body.active).toBe(true);
    });
  });
});
