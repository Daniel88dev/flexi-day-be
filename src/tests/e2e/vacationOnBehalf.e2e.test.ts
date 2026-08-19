import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  setupTestEnvironment,
  cleanupTestData,
  createTestUser,
  type TestContext,
  type TestUser,
} from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { session } from "../../db/schema/auth-schema.js";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

// Booking is bounded to this year through the end of the next, so fixed dates
// would fall out of range as time passes.
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const shift = (base: Date, days: number) => {
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};
const firstMondayOfDecember = () => {
  const day = new Date(Date.UTC(new Date().getUTCFullYear(), 11, 1));
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  return day;
};
const MONDAY_OF_WEEK = firstMondayOfDecember();
const MON = isoDay(MONDAY_OF_WEEK);
const TUE = isoDay(shift(MONDAY_OF_WEEK, 1));
const WED = isoDay(shift(MONDAY_OF_WEEK, 2));

describe("Admin on-behalf vacation management E2E", () => {
  let context: TestContext;
  let orgAdmin: TestUser;

  const addToGroup = async (
    userId: string,
    groupId: string,
    permissions: { adminAccess?: boolean; approverAccess?: boolean } = {}
  ) => {
    await db.insert(groupUsers).values({
      id: uuidv4(),
      groupId,
      userId,
      controlledUser: true,
      adminAccess: permissions.adminAccess ?? false,
      approverAccess: permissions.approverAccess ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  // user1 owns the organization (group manager); a delegated admin holds an
  // organization_users row and no group membership at all.
  const grantOrgAdmin = async (userId: string) => {
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.ownerUserId, context.user1.id));
    await db
      .insert(organizationUsers)
      .values({
        id: uuidv4(),
        organizationId: organization!.id,
        userId,
        grantedByUserId: context.user1.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  };

  beforeAll(async () => {
    context = await setupTestEnvironment();
    orgAdmin = await createTestUser("orgadmin@test.com", "Org Admin", "password123");
  });

  afterAll(async () => {
    await db.delete(organizationUsers);
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(vacation);
    await db.delete(groupUsers);
    await db.delete(session);
  });

  const createOnBehalf = (cookie: string[], body: Record<string, unknown>) =>
    request(context.app)
      .post("/api/vacation/create-vacation")
      .set("Cookie", cookie)
      .send({ groupId: context.group.id, from: WED, to: WED, userId: context.user2.id, ...body });

  describe("create on behalf", () => {
    it("lets a group admin book an auto-approved day for a member, fully attributed", async () => {
      await addToGroup(context.user1.id, context.group.id, { adminAccess: true });
      await addToGroup(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      const response = await createOnBehalf(cookie, { autoApprove: true }).expect(201);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        userId: context.user2.id,
        createdByUserId: context.user1.id,
        approvedBy: context.user1.id,
      });
      expect(response.body[0].approvedAt).not.toBeNull();

      const detail = await request(context.app)
        .get(`/api/vacation/${response.body[0].id as string}`)
        .set("Cookie", cookie)
        .expect(200);
      expect(detail.body.createdByUser).toMatchObject({ id: context.user1.id });
      const eventTypes = detail.body.history.map((e: { eventType: string }) => e.eventType);
      expect(eventTypes).toEqual(expect.arrayContaining(["CREATED", "APPROVED"]));
    });

    it("leaves the record pending when autoApprove is off", async () => {
      await addToGroup(context.user1.id, context.group.id, { adminAccess: true });
      await addToGroup(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      const response = await createOnBehalf(cookie, { autoApprove: false }).expect(201);

      expect(response.body[0].approvedAt).toBeNull();
      expect(response.body[0].createdByUserId).toBe(context.user1.id);
    });

    it("refuses a plain member booking for someone else", async () => {
      await addToGroup(context.user1.id, context.group.id);
      await addToGroup(context.user2.id, context.group.id);
      // user2 (no admin flag) tries to book for user1.
      const cookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({
          groupId: context.group.id,
          from: WED,
          to: WED,
          userId: context.user1.id,
          autoApprove: true,
        })
        .expect(403);
    });

    it("refuses autoApprove on a self-booking", async () => {
      await addToGroup(context.user1.id, context.group.id, { adminAccess: true });
      const cookie = await authCookieFor(context.user1.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({
          groupId: context.group.id,
          from: WED,
          to: WED,
          userId: context.user1.id,
          autoApprove: true,
        })
        .expect(422);
    });
  });

  describe("PATCH /api/vacation", () => {
    const bookedDay = async () => {
      await addToGroup(context.user1.id, context.group.id, { adminAccess: true });
      await addToGroup(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);
      const created = await createOnBehalf(cookie, { autoApprove: true }).expect(201);
      return { cookie, id: created.body[0].id as string };
    };

    it("edits per-day fields and appends an UPDATED event with a change summary", async () => {
      const { cookie, id } = await bookedDay();

      const response = await request(context.app)
        .patch("/api/vacation")
        .set("Cookie", cookie)
        .send({ ids: [id], vacationType: "SICK", halfDay: true })
        .expect(200);

      expect(response.body[0]).toMatchObject({ vacationType: "SICK", halfDay: true });

      const detail = await request(context.app)
        .get(`/api/vacation/${id}`)
        .set("Cookie", cookie)
        .expect(200);
      const updatedEvent = detail.body.history.find(
        (e: { eventType: string }) => e.eventType === "UPDATED"
      );
      expect(updatedEvent).toBeDefined();
      expect(updatedEvent.reason).toContain("Type: Vacation → Sick");
      expect(updatedEvent.actor).toMatchObject({ id: context.user1.id });
    });

    it("refuses a non-admin caller", async () => {
      const { id } = await bookedDay();
      const memberCookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .patch("/api/vacation")
        .set("Cookie", memberCookie)
        .send({ ids: [id], note: "sneaky" })
        .expect(403);
    });

    it("404s for a cancelled record", async () => {
      const { cookie, id } = await bookedDay();
      await request(context.app).delete(`/api/vacation/${id}`).set("Cookie", cookie).expect(200);

      await request(context.app)
        .patch("/api/vacation")
        .set("Cookie", cookie)
        .send({ ids: [id], note: "too late" })
        .expect(404);
    });
  });

  describe("delete attribution and cancelled visibility", () => {
    it("stamps deletedBy, keeps the row visible via includeCancelled, and frees the day", async () => {
      await addToGroup(context.user1.id, context.group.id, { adminAccess: true });
      await addToGroup(context.user2.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);
      const created = await createOnBehalf(cookie, { autoApprove: true }).expect(201);
      const id = created.body[0].id as string;

      await request(context.app)
        .delete(`/api/vacation/${id}`)
        .set("Cookie", cookie)
        .send({ reason: "Booked by mistake" })
        .expect(200);

      const detail = await request(context.app)
        .get(`/api/vacation/${id}`)
        .set("Cookie", cookie)
        .expect(200);
      expect(detail.body.deletedAt).not.toBeNull();
      expect(detail.body.deletedByUser).toMatchObject({ id: context.user1.id });

      const [year, month] = WED.split("-");
      const memberCookie = await authCookieFor(context.user2.id);
      const withCancelled = await request(context.app)
        .get("/api/vacation")
        .set("Cookie", memberCookie)
        .query({ year, month: Number(month), includeCancelled: "true" })
        .expect(200);
      expect(withCancelled.body.map((r: { id: string }) => r.id)).toContain(id);

      const without = await request(context.app)
        .get("/api/vacation")
        .set("Cookie", memberCookie)
        .query({ year, month: Number(month) })
        .expect(200);
      expect(without.body.map((r: { id: string }) => r.id)).not.toContain(id);

      // The day is free again: the partial unique index ignores cancelled rows.
      await createOnBehalf(cookie, { autoApprove: true }).expect(201);
    });
  });

  describe("delegated org admin", () => {
    it("has full on-behalf CRUD without any group membership", async () => {
      await addToGroup(context.user2.id, context.group.id);
      await grantOrgAdmin(orgAdmin.id);
      const cookie = await authCookieFor(orgAdmin.id);

      const created = await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({
          groupId: context.group.id,
          from: MON,
          to: TUE,
          userId: context.user2.id,
          autoApprove: true,
        })
        .expect(201);
      expect(created.body).toHaveLength(2);
      expect(created.body[0]).toMatchObject({
        createdByUserId: orgAdmin.id,
        approvedBy: orgAdmin.id,
      });

      const ids = created.body.map((r: { id: string }) => r.id);
      await request(context.app)
        .patch("/api/vacation")
        .set("Cookie", cookie)
        .send({ ids, note: "team offsite" })
        .expect(200);

      await request(context.app)
        .delete(`/api/vacation/${ids[0] as string}`)
        .set("Cookie", cookie)
        .expect(200);
    });

    it("still cannot approve a member-submitted pending request", async () => {
      await addToGroup(context.user2.id, context.group.id);
      await grantOrgAdmin(orgAdmin.id);

      const memberCookie = await authCookieFor(context.user2.id);
      const created = await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", memberCookie)
        .send({ groupId: context.group.id, from: WED, to: WED })
        .expect(201);
      const id = created.body[0].id as string;

      const cookie = await authCookieFor(orgAdmin.id);
      await request(context.app)
        .post(`/api/vacation/approve/${id}`)
        .set("Cookie", cookie)
        .expect(403);
    });
  });
});
