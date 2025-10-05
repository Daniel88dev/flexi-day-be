import { createServer } from "../../../server.js";
import type { Express } from "express";
import { db } from "../../../db/db.js";
import { user } from "../../../db/schema/auth-schema.js";
import { groups } from "../../../db/schema/group-schema.js";
import { vacation } from "../../../db/schema/vacation-schema.js";
import { groupUsers } from "../../../db/schema/group-users-schema.js";
import { session } from "../../../db/schema/auth-schema.js";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

export interface TestUser {
  id: string;
  email: string;
  password: string;
  name: string;
  sessionToken?: string;
}

export interface TestGroup {
  id: string;
  groupName: string;
  managerUserId: string;
  mainApprovalUser?: string;
}

export interface TestContext {
  app: Express;
  user1: TestUser;
  user2: TestUser;
  approverUser: TestUser;
  group: TestGroup;
}

// Shared test data to avoid duplicates
let cachedContext: TestContext | null = null;

/**
 * Creates a test user in the database
 */
export async function createTestUser(
  email: string,
  name: string,
  password: string
): Promise<TestUser> {
  const userId = uuidv4();

  // Check if user already exists
  const existingUser = await db
    .select()
    .from(user)
    .where(eq(user.email, email));

  if (existingUser.length > 0) {
    return {
      id: existingUser[0]!.id,
      email: existingUser[0]!.email,
      name: existingUser[0]!.name,
      password,
    };
  }

  await db.insert(user).values({
    id: userId,
    email,
    name,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { id: userId, email, name, password };
}

/**
 * Creates a test group in the database
 */
export async function createTestGroup(
  groupName: string,
  managerUserId: string,
  mainApprovalUser?: string
): Promise<TestGroup> {
  const groupId = uuidv4();

  await db.insert(groups).values({
    id: groupId,
    groupName,
    managerUserId,
    mainApprovalUser: mainApprovalUser || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { id: groupId, groupName, managerUserId, mainApprovalUser };
}

/**
 * Sets up the test environment with users and groups
 * Uses cached context to avoid duplicate user creation
 */
export async function setupTestEnvironment(): Promise<TestContext> {
  if (cachedContext) {
    return cachedContext;
  }

  const app = createServer();

  // Create test users
  const user1 = await createTestUser(
    "user1@test.com",
    "Test User 1",
    "password123"
  );
  const user2 = await createTestUser(
    "user2@test.com",
    "Test User 2",
    "password123"
  );
  const approverUser = await createTestUser(
    "approver@test.com",
    "Approver User",
    "password123"
  );

  // Create test group
  const group = await createTestGroup("Test Group", user1.id, approverUser.id);

  cachedContext = { app, user1, user2, approverUser, group };
  return cachedContext;
}

/**
 * Cleans up test data from the database
 */
export async function cleanupTestData() {
  try {
    // Delete in correct order due to foreign key constraints
    await db.delete(vacation);
    await db.delete(groupUsers);
    await db.delete(session);
    await db.delete(groups);
    await db.delete(user);

    // Clear cache
    cachedContext = null;
  } catch (error) {
    console.error("Error cleaning up test data:", error);
    throw error;
  }
}

/**
 * Creates a vacation for testing
 */
export async function createTestVacation(
  userId: string,
  groupId: string,
  requestedDay: string
) {
  const vacationId = uuidv4();

  await db.insert(vacation).values({
    id: vacationId,
    userId,
    groupId,
    requestedDay,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return vacationId;
}
