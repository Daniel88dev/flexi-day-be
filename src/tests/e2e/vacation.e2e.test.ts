import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  setupTestEnvironment,
  cleanupTestData,
  createTestVacation,
  type TestContext,
} from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { session } from "../../db/schema/auth-schema.js";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

describe("Vacation API E2E Tests", () => {
  let context: TestContext;

  const addToGroup = async (userId: string, groupId: string) => {
    await db.insert(groupUsers).values({
      id: uuidv4(),
      groupId,
      userId,
      controlledUser: true,
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
        .send({ groupId: context.group.id, from: "2025-12-24", to: "2025-12-24" })
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

      // 2025-12-24 is a Wednesday, inside the group's default Mon–Fri.
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: "2025-12-24", to: "2025-12-24" })
        .expect(201);

      expect(response.body).toHaveLength(1);

      const rows = await db.select().from(vacation).where(eq(vacation.userId, context.user1.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requestedDay: "2025-12-24", halfDay: false });
    });

    it("should persist halfDay when the request asks for one", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: "2025-12-24", to: "2025-12-24", halfDay: true })
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
        .send({ groupId: context.group.id, from: "2025-12-24", to: "2025-12-24" })
        .expect(201);

      const rows = await db.select().from(vacation).where(eq(vacation.userId, context.user1.id));
      expect(rows[0]?.halfDay).toBe(false);
    });

    it("should create one row per working day in a range", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      // Mon 2025-12-22 → Fri 2025-12-26 spans five weekdays.
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: "2025-12-22", to: "2025-12-26" })
        .expect(201);

      expect(response.body).toHaveLength(5);
    });

    it("should drop non-working days inside a range", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      // Fri 2025-12-26 → Mon 2025-12-29 covers a weekend; only the two
      // weekdays should be booked.
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: "2025-12-26", to: "2025-12-29" })
        .expect(201);

      expect(response.body).toHaveLength(2);
      const days = (response.body as { requestedDay: string }[])
        .map((row) => row.requestedDay)
        .sort();
      expect(days).toEqual(["2025-12-26", "2025-12-29"]);
    });

    it("should return 422 when the range contains no working day", async () => {
      await addToGroup(context.user1.id, context.group.id);
      const cookie = await authCookieFor(context.user1.id);

      // Sat 2025-12-27 → Sun 2025-12-28.
      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: "2025-12-27", to: "2025-12-28" })
        .expect(422);
    });

    it("should return 403 for a group the caller is not a member of", async () => {
      const cookie = await authCookieFor(context.user2.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: context.group.id, from: "2025-12-24", to: "2025-12-24" })
        .expect(403);
    });

    // The membership check runs before the group lookup, so an unknown group is
    // deliberately indistinguishable from one the caller cannot see.
    it("should return 403 rather than 404 for a group that does not exist", async () => {
      const cookie = await authCookieFor(context.user1.id);

      await request(context.app)
        .post("/api/vacation/create-vacation")
        .set("Cookie", cookie)
        .send({ groupId: uuidv4(), from: "2025-12-24", to: "2025-12-24" })
        .expect(403);
    });
  });

  // Uniqueness only covers live rows, so a day whose only rows are rejected or
  // cancelled is free again. Before that was a partial index, the leftover row
  // kept the day booked forever.
  describe("POST /api/vacation/create-vacation — re-requesting a day", () => {
    const bookDay = (cookie: string, day = "2025-12-24") =>
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
        errors: [{ context: { conflictingDays: ["2025-12-24"] } }],
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

      // Stale approver queue: approving would un-reject the old row onto a day
      // the live request now holds.
      await request(context.app)
        .post(`/api/vacation/approve/${rejectedId}`)
        .set("Cookie", approverCookie)
        .expect(409);

      const rows = await db.select().from(vacation).where(eq(vacation.id, rejectedId));
      expect(rows[0]?.rejectedAt).not.toBeNull();
      expect(rows[0]?.approvedAt).toBeNull();
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
  });
});
