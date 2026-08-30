import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  setupTestEnvironment,
  cleanupTestData,
  createTestGroup,
  createTestUser,
  createTestVacation,
  type TestContext,
  type TestGroup,
  type TestUser,
} from "./helpers/testSetup.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { upsertUserYearQuota } from "../../services/userYearQuotas/userYearQuotasServices.js";
import { setMirrorsIntoGroupForUser } from "../../services/groupMirror/groupMirrorServices.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
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
const WED = isoDay(shift(MONDAY_OF_WEEK, 2));
const FRI = isoDay(shift(MONDAY_OF_WEEK, 4));
const SAT = isoDay(shift(MONDAY_OF_WEEK, 5));
const SUN = isoDay(shift(MONDAY_OF_WEEK, 6));
const NEXT_MON = isoDay(shift(MONDAY_OF_WEEK, 7));

describe("Vacation API E2E Tests", () => {
  let context: TestContext;

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

  beforeAll(async () => {
    context = await setupTestEnvironment();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(vacation);
    await db.delete(groupMirrors);
    await db.delete(groupUsers);
    await db.delete(session);
  });

  describe("GET /api/vacation", () => {
    it("should return 401 when not authenticated", async () => {
      const response = await request(context.app).get("/api/vacation").expect(401);

      expect(response.body).toBeDefined();
    });

    it("should return an empty array when the user has no vacations", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      const response = await request(context.app)
        .get("/api/vacation")
        .set("Cookie", cookie)
        .query({ year: 2025, month: 1 })
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it("should return the user's vacations for the requested month", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const vacationId = await createTestVacation(context.user1.id, context.group.id, "2025-01-15");
      const cookie = await authCookieFor(context.user1.id);

      const response = await request(context.app)
        .get("/api/vacation")
        .set("Cookie", cookie)
        .query({ year: 2025, month: 1 })
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        id: vacationId,
        userId: context.user1.id,
        requestedDay: "2025-01-15",
        halfDay: false,
      });
    });

    it("should exclude vacations outside the requested month", async () => {
      await addToGroup(context.user1.id, context.group.id);
      await createTestVacation(context.user1.id, context.group.id, "2025-01-15");
      const cookie = await authCookieFor(context.user1.id);

      const response = await request(context.app)
        .get("/api/vacation")
        .set("Cookie", cookie)
        .query({ year: 2025, month: 2 })
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it("should not leak another user's vacations", async () => {
      await addToGroup(context.user1.id, context.group.id);
      await addToGroup(context.user2.id, context.group.id);
      await createTestVacation(context.user1.id, context.group.id, "2025-01-15");
      const cookie = await authCookieFor(context.user2.id);

      const response = await request(context.app)
        .get("/api/vacation")
        .set("Cookie", cookie)
        .query({ year: 2025, month: 1 })
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it("should return 422 for an out-of-range month", async () => {
      const cookie = await authCookieFor(context.user1.id);

      await request(context.app)
        .get("/api/vacation")
        .set("Cookie", cookie)
        .query({ year: 2025, month: 13 })
        .expect(422);
    });
  });

  describe("POST /api/vacation/create-vacation", () => {
    it("should return 401 when not authenticated", async () => {
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .send({ groupId: context.group.id, from: WED, to: WED })
        .expect(401);

      expect(response.body).toBeDefined();
    });

    it("should return 422 when the request body is invalid", async () => {
      const cookie = await authCookieFor(context.user1.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: "not-a-uuid", from: "invalid-date", to: "invalid-date" })
        .expect(422);
    });

    it("should create a full day and persist it", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      // A Wednesday, inside the group's default Mon–Fri working days.
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: WED, to: WED })
        .expect(201);

      expect(response.body).toHaveLength(1);

      const rows = await db.select().from(vacation).where(eq(vacation.userId, context.user1.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requestedDay: WED, halfDay: false });
    });

    it("should persist halfDay when the request asks for one", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: WED, to: WED, halfDay: true })
        .expect(201);

      const rows = await db.select().from(vacation).where(eq(vacation.userId, context.user1.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.halfDay).toBe(true);
    });

    it("should default halfDay to false when omitted", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: WED, to: WED })
        .expect(201);

      const rows = await db.select().from(vacation).where(eq(vacation.userId, context.user1.id));
      expect(rows[0]?.halfDay).toBe(false);
    });

    it("should create one row per working day in a range", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      // Mon → Fri spans five weekdays.
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: MON, to: FRI })
        .expect(201);

      expect(response.body).toHaveLength(5);
    });

    it("should drop non-working days inside a range", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      // Fri → the following Mon covers a weekend; only the two
      // weekdays should be booked.
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: FRI, to: NEXT_MON })
        .expect(201);

      expect(response.body).toHaveLength(2);
      const days = (response.body as { requestedDay: string }[])
        .map((row) => row.requestedDay)
        .sort();
      expect(days).toEqual([FRI, NEXT_MON]);
    });

    it("should return 422 when the range contains no working day", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      // A full weekend.
      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: SAT, to: SUN })
        .expect(422);
    });

    it("should return 403 for a group the caller is not a member of", async () => {
      const cookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: WED, to: WED })
        .expect(403);
    });

    // The membership check runs before the group lookup, so an unknown group is
    // deliberately indistinguishable from one the caller cannot see.
    it("should return 403 rather than 404 for a group that does not exist", async () => {
      const cookie = await authCookieFor(context.user1.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: uuidv4(), from: WED, to: WED })
        .expect(403);
    });
  });

  // Uniqueness only covers live rows, so a day whose only rows are rejected or
  // cancelled is free again. Before that was a partial index, the leftover row
  // kept the day booked forever.
  describe("POST /api/vacation/create-vacation — re-requesting a day", () => {
    const bookDay = (cookie: string, day = WED) =>
      request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: day, to: day });

    it("should return 409 while the day is still held by a live row", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      await bookDay(cookie).expect(201);
      const response = await bookDay(cookie).expect(409);

      expect(response.body).toMatchObject({
        errors: [{ context: { conflictingDays: [WED] } }],
      });
    });

    it("should let the user book a day again after the request was rejected", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);
      const approverCookie = await authCookieFor(context.approverUser.id);

      const created = await bookDay(cookie).expect(201);
      const rejectedId = (created.body as { id: string }[])[0]?.id;

      await request(context.app)
        .post(`/api/vacation/reject/${rejectedId ?? ""}`)
        .set("Cookie", approverCookie)
        .send({ reason: "not this week" })
        .expect(200);

      await bookDay(cookie).expect(201);

      // The rejected row is kept for history alongside the new pending one.
      const rows = await db.select().from(vacation).where(eq(vacation.userId, context.user1.id));
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.rejectedAt !== null)).toHaveLength(1);
      expect(rows.filter((row) => row.rejectedAt === null && row.deletedAt === null)).toHaveLength(
        1
      );
    });

    it("should let the user book a day again after cancelling it", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      const created = await bookDay(cookie).expect(201);
      const cancelledId = (created.body as { id: string }[])[0]?.id;

      await request(context.app)
        .delete(`/api/vacation/${cancelledId ?? ""}`)
        .set("Cookie", cookie)
        .send({})
        .expect(200);

      await bookDay(cookie).expect(201);

      const rows = await db.select().from(vacation).where(eq(vacation.userId, context.user1.id));
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.deletedAt !== null)).toHaveLength(1);
    });

    it("should return 409 when approving a rejected row whose day was booked again", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);
      const approverCookie = await authCookieFor(context.approverUser.id);

      const created = await bookDay(cookie).expect(201);
      const rejectedId = (created.body as { id: string }[])[0]?.id ?? "";

      await request(context.app)
        .post(`/api/vacation/reject/${rejectedId}`)
        .set("Cookie", approverCookie)
        .send({ reason: "not this week" })
        .expect(200);
      await bookDay(cookie).expect(201);

      // A decided row is not re-decidable, so this never reaches the day the
      // live request now holds.
      await request(context.app)
        .post(`/api/vacation/approve/${rejectedId}`)
        .set("Cookie", approverCookie)
        .expect(409);

      const rows = await db.select().from(vacation).where(eq(vacation.id, rejectedId));
      expect(rows[0]?.rejectedAt).not.toBeNull();
      expect(rows[0]?.approvedAt).toBeNull();
    });
  });

  describe("POST /api/vacation/create-vacation — Sick day benefit", () => {
    let manager: TestUser;
    let member: TestUser;
    let benefitGroup: TestGroup;
    let organizationId: string;

    const YEAR = MONDAY_OF_WEEK.getUTCFullYear();

    beforeAll(async () => {
      manager = await createTestUser("sickday-manager@test.com", "Sick Day Manager", "password123");
      member = await createTestUser("sickday-member@test.com", "Sick Day Member", "password123");
      benefitGroup = await createTestGroup("Sick Day Group", manager.id);
      organizationId = (await ensureOrganizationForUser(manager.id)).id;
    });

    // The outer beforeEach clears memberships, so each test re-joins.
    beforeEach(async () => {
      await addToGroup(member.id, benefitGroup.id);
    });

    /** Pins the toggle and the subscription so no test inherits another's state. */
    const setBenefit = async (enabled: boolean, plan: "active" | "lapsed") => {
      await db
        .update(organizations)
        .set({ sickDayBenefitEnabled: enabled })
        .where(eq(organizations.id, organizationId));
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: plan === "active" ? subscriptionStatus.Active : subscriptionStatus.Canceled,
        graceEndsAt: plan === "active" ? null : new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
    };

    const allowSickDays = async (days: number) => {
      await upsertUserYearQuota({
        id: uuidv4(),
        userId: member.id,
        groupId: benefitGroup.id,
        relatedYear: YEAR.toString(),
        vacationDays: 20,
        homeOfficeDays: 0,
        sickDays: days,
        carriedOverDays: 0,
      });
    };

    const bookSickDay = async (cookie: string, day: string, halfDay = false) =>
      request(context.app).post("/api/vacation/create-vacation").set("Cookie", cookie).send({
        groupId: benefitGroup.id,
        from: day,
        to: day,
        vacationType: CalendarRecordType.SickDay,
        halfDay,
      });

    it("rejects a sick day while the benefit is off, even on a paid plan", async () => {
      await setBenefit(false, "active");
      await allowSickDays(5);
      const cookie = await authCookieFor(member.id);

      const res = await bookSickDay(cookie, WED);

      expect(res.status).toBe(422);
      expect(res.body.errors[0].context.reason).toBe("SICK_DAY_BENEFIT_DISABLED");
    });

    it("meters half days against the allowance once the benefit is on", async () => {
      await setBenefit(true, "active");
      await allowSickDays(1);
      const cookie = await authCookieFor(member.id);

      // Two half days consume the whole allowance of 1; anything more exceeds.
      await bookSickDay(cookie, WED, true).then((res) => expect(res.status).toBe(201));
      await bookSickDay(cookie, FRI, true).then((res) => expect(res.status).toBe(201));

      const overdrawn = await bookSickDay(cookie, MON, true);
      expect(overdrawn.status).toBe(422);
      expect(overdrawn.body.errors[0].message).toBe(
        "This would exceed the allowance for that leave type"
      );
    });

    it("goes dormant on lapse, preserves the data, and revives on re-subscribe", async () => {
      await setBenefit(true, "active");
      await allowSickDays(5);
      const cookie = await authCookieFor(member.id);

      await bookSickDay(cookie, WED).then((res) => expect(res.status).toBe(201));

      await setBenefit(true, "lapsed");
      const dormant = await bookSickDay(cookie, FRI);
      expect(dormant.status).toBe(422);
      expect(dormant.body.errors[0].context.reason).toBe("SICK_DAY_BENEFIT_DISABLED");

      // Nothing was deleted or altered by the lapse.
      const stored = await db.select().from(vacation).where(eq(vacation.userId, member.id));
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        requestedDay: WED,
        vacationType: CalendarRecordType.SickDay,
      });

      await setBenefit(true, "active");
      await bookSickDay(cookie, FRI).then((res) => expect(res.status).toBe(201));
    });
  });

  describe("POST /api/vacation/approve/:id", () => {
    let vacationId: string;

    beforeEach(async () => {
      vacationId = await createTestVacation(context.user1.id, context.group.id, "2025-12-24");
    });

    it("should return 401 when not authenticated", async () => {
      const response = await request(context.app)
        .post(`/api/vacation/approve/${vacationId}`)
        .expect(401);

      expect(response.body).toBeDefined();
    });

    it("should return 422 when the vacation id is not a valid UUID", async () => {
      const cookie = await authCookieFor(context.approverUser.id);

      await request(context.app)
        .post("/api/vacation/approve/not-a-uuid")
        .set("Cookie", cookie)
        .expect(422);
    });

    it("should return 404 when the vacation does not exist", async () => {
      const cookie = await authCookieFor(context.approverUser.id);

      await request(context.app)
        .post(`/api/vacation/approve/${uuidv4()}`)
        .set("Cookie", cookie)
        .expect(404);
    });

    it("should approve and stamp the approver when the caller may approve", async () => {
      const cookie = await authCookieFor(context.approverUser.id);

      await request(context.app)
        .post(`/api/vacation/approve/${vacationId}`)
        .set("Cookie", cookie)
        .expect(200);

      const rows = await db.select().from(vacation).where(eq(vacation.id, vacationId));
      expect(rows[0]?.approvedAt).not.toBeNull();
      expect(rows[0]?.approvedBy).toBe(context.approverUser.id);
    });

    it("should return 403 when the caller is not an approver", async () => {
      const cookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .post(`/api/vacation/approve/${vacationId}`)
        .set("Cookie", cookie)
        .expect(403);

      const rows = await db.select().from(vacation).where(eq(vacation.id, vacationId));
      expect(rows[0]?.approvedAt).toBeNull();
    });

    it("lets a member holding approverAccess decide, without any group role", async () => {
      await addToGroup(context.user2.id, context.group.id, { approverAccess: true });
      const cookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .post(`/api/vacation/approve/${vacationId}`)
        .set("Cookie", cookie)
        .expect(200);

      const rows = await db.select().from(vacation).where(eq(vacation.id, vacationId));
      expect(rows[0]?.approvedBy).toBe(context.user2.id);
    });

    it("lets an approverAccess member approve their own request", async () => {
      await addToGroup(context.user2.id, context.group.id, { approverAccess: true });
      const own = await createTestVacation(context.user2.id, context.group.id, "2025-12-23");
      const cookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .post(`/api/vacation/approve/${own}`)
        .set("Cookie", cookie)
        .expect(200);

      const rows = await db.select().from(vacation).where(eq(vacation.id, own));
      expect(rows[0]?.approvedBy).toBe(context.user2.id);
    });

    it("refuses their own request while their records are mirrored into the group", async () => {
      await addToGroup(context.user2.id, context.group.id, { approverAccess: true });
      const otherGroup = await createTestGroup("Other Team", context.user1.id, context.user1.id);
      await addToGroup(context.user2.id, otherGroup.id);
      await setMirrorsIntoGroupForUser(
        context.user2.id,
        context.group.id,
        [otherGroup.id],
        [otherGroup.id]
      );

      const own = await createTestVacation(context.user2.id, context.group.id, "2025-12-23");
      const cookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .post(`/api/vacation/approve/${own}`)
        .set("Cookie", cookie)
        .expect(403);

      const rows = await db.select().from(vacation).where(eq(vacation.id, own));
      expect(rows[0]?.approvedAt).toBeNull();
    });

    it("still refuses a role-based approver deciding on their own request", async () => {
      const own = await createTestVacation(context.approverUser.id, context.group.id, "2025-12-23");
      const cookie = await authCookieFor(context.approverUser.id);

      await request(context.app)
        .post(`/api/vacation/approve/${own}`)
        .set("Cookie", cookie)
        .expect(403);
    });
  });
});
