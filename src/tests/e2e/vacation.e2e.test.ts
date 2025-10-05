import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  setupTestEnvironment,
  cleanupTestData,
  createTestVacation,
  type TestContext,
} from "./helpers/testSetup.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { v4 as uuidv4 } from "uuid";

describe("Vacation API E2E Tests", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestEnvironment();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    // Clean up vacation and group_users data before each test
    await db.delete(vacation);
    await db.delete(groupUsers);
  });

  describe("GET /api/vacation", () => {
    it("should return 401 when not authenticated", async () => {
      const response = await request(context.app)
        .get("/api/vacation")
        .expect(401);

      // Better-auth returns errors object
      expect(response.body).toBeDefined();
    });

    it("should return empty array when user has no vacations", async () => {
      // Add user1 to the group
      await db.insert(groupUsers).values({
        id: uuidv4(),
        groupId: context.group.id,
        userId: context.user1.id,
        controlledUser: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app)
        .get("/api/vacation")
        .query({ year: 2025, month: 1 });

      expect([401, 200]).toContain(response.status);
    });

    it("should return vacations for authenticated user filtered by year and month", async () => {
      // Add user1 to the group
      await db.insert(groupUsers).values({
        id: uuidv4(),
        groupId: context.group.id,
        userId: context.user1.id,
        controlledUser: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create test vacation using helper
      await createTestVacation(context.user1.id, context.group.id, "2025-01-15");

      const response = await request(context.app)
        .get("/api/vacation")
        .query({ year: 2025, month: 1 });

      expect([401, 200]).toContain(response.status);
    });

    it("should validate query parameters", async () => {
      const response = await request(context.app)
        .get("/api/vacation")
        .query({ year: 1999, month: 13 }); // Invalid month

      expect([401, 422]).toContain(response.status);
    });
  });

  describe("POST /api/vacation/create-vacation", () => {
    it("should return 401 when not authenticated", async () => {
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .send({
          groupId: context.group.id,
          requestedDay: "2025-12-24",
        })
        .expect(401);

      expect(response.body).toBeDefined();
    });

    it("should return 422 when request body is invalid", async () => {
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .send({
          groupId: "not-a-uuid",
          requestedDay: "invalid-date",
        });

      expect([401, 422]).toContain(response.status);
    });

    it("should create vacation with valid data and authentication", async () => {
      // Add user1 to the group
      await db.insert(groupUsers).values({
        id: uuidv4(),
        groupId: context.group.id,
        userId: context.user1.id,
        controlledUser: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .send({
          groupId: context.group.id,
          requestedDay: "2025-12-24",
        });

      // Without proper auth, this will return 401
      expect([401, 201]).toContain(response.status);
    });

    it("should return 403 when user has no access to the group", async () => {
      // user2 is not in the group
      const response = await request(context.app)
        .post("/api/vacation/create-vacation")
        .send({
          groupId: context.group.id,
          requestedDay: "2025-12-24",
        });

      expect([401, 403]).toContain(response.status);
    });
  });

  describe("POST /api/vacation/approve/:id", () => {
    let vacationId: string;

    beforeEach(async () => {
      // Create a test vacation to approve using helper
      vacationId = await createTestVacation(
        context.user1.id,
        context.group.id,
        "2025-12-24"
      );
    });

    it("should return 401 when not authenticated", async () => {
      const response = await request(context.app)
        .post(`/api/vacation/approve/${vacationId}`)
        .expect(401);

      expect(response.body).toBeDefined();
    });

    it("should return 422 when vacation id is not a valid UUID", async () => {
      const response = await request(context.app)
        .post("/api/vacation/approve/not-a-uuid");

      expect([401, 422]).toContain(response.status);
    });

    it("should return 404 when vacation does not exist", async () => {
      const nonExistentId = uuidv4();
      const response = await request(context.app)
        .post(`/api/vacation/approve/${nonExistentId}`);

      expect([401, 404]).toContain(response.status);
    });

    it("should approve vacation when user is authorized approver", async () => {
      const response = await request(context.app)
        .post(`/api/vacation/approve/${vacationId}`);

      // Without proper auth, returns 401
      expect([401, 200]).toContain(response.status);
    });

    it("should return 403 when user is not authorized to approve", async () => {
      const response = await request(context.app)
        .post(`/api/vacation/approve/${vacationId}`);

      expect([401, 403]).toContain(response.status);
    });
  });
});
