import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { generateId } from "better-auth";
import { db } from "../../db/db.js";
import { session as sessionTable, user } from "../../db/schema/auth-schema.js";
import { authSecretFingerprint as fingerprintTable } from "../../db/schema/auth-secret-schema.js";
import { pushEnvironment, pushRegistrations } from "../../db/schema/push-registration-schema.js";
import {
  authSecretFingerprint,
  checkAuthSecret,
} from "../../services/authSecret/authSecretServices.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const SECRET = "first-secret-Vq7Rz2mWb9XfT4nLp8VdC3sHy6JgA1eE";
const ROTATED = "rotated-secret-Kx3Jm9VqT2mWb8YfR5nLp1DcZ7sHg4Ae";

/**
 * The boot check against a real database. Files run one at a time, so
 * deleting every session here cannot pull rows from under another suite.
 */
describe("auth secret boot check", () => {
  beforeEach(async () => {
    await db.delete(fingerprintTable);
    await cleanupTestData();
  });

  afterAll(async () => {
    await db.delete(fingerprintTable);
    await cleanupTestData();
  });

  const phoneWithRegistration = async () => {
    const userId = generateId();
    await db.insert(user).values({
      id: userId,
      name: "Boot Check Subject",
      email: `boot-${userId.toLowerCase()}@report-e2e.test`,
      emailVerified: true,
    });
    const sessionId = generateId();
    await db.insert(sessionTable).values({
      id: sessionId,
      userId,
      token: generateId(),
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
      deviceId: `device-${uuidv4()}`,
    });
    await db.insert(pushRegistrations).values({
      sessionId,
      token: uuidv4().replace(/-/g, "").repeat(2),
      environment: pushEnvironment.Sandbox,
    });
    return sessionId;
  };

  const stored = () => db.select().from(fingerprintTable);

  it("records the fingerprint on the first boot and deletes nothing", async () => {
    await phoneWithRegistration();

    expect(await checkAuthSecret(SECRET)).toEqual({ outcome: "recorded", sessionsDeleted: 0 });

    expect(await stored()).toEqual([
      expect.objectContaining({ fingerprint: authSecretFingerprint(SECRET) }),
    ]);
    expect(await db.select().from(sessionTable)).toHaveLength(1);
    expect(await db.select().from(pushRegistrations)).toHaveLength(1);
  });

  it("leaves every session alone when the secret is the one it recorded", async () => {
    await checkAuthSecret(SECRET);
    await phoneWithRegistration();

    expect(await checkAuthSecret(SECRET)).toEqual({ outcome: "unchanged", sessionsDeleted: 0 });

    expect(await db.select().from(sessionTable)).toHaveLength(1);
    expect(await db.select().from(pushRegistrations)).toHaveLength(1);
  });

  it("deletes every session, and with them every registration, when the secret changed", async () => {
    await checkAuthSecret(SECRET);
    await phoneWithRegistration();
    await phoneWithRegistration();

    const result = await checkAuthSecret(ROTATED);

    expect(result).toEqual({ outcome: "rotated", sessionsDeleted: 2 });
    expect(await db.select().from(sessionTable)).toHaveLength(0);
    expect(await db.select().from(pushRegistrations)).toHaveLength(0);
    expect(await stored()).toEqual([
      expect.objectContaining({ fingerprint: authSecretFingerprint(ROTATED) }),
    ]);
  });

  it("deletes once per rotation: the next boot on the new secret changes nothing", async () => {
    await checkAuthSecret(SECRET);
    await checkAuthSecret(ROTATED);
    await phoneWithRegistration();

    expect(await checkAuthSecret(ROTATED)).toEqual({ outcome: "unchanged", sessionsDeleted: 0 });
    expect(await db.select().from(sessionTable)).toHaveLength(1);
  });

  it("agrees across instances that boot at the same moment", async () => {
    await checkAuthSecret(SECRET);
    await phoneWithRegistration();

    const outcomes = await Promise.all([checkAuthSecret(ROTATED), checkAuthSecret(ROTATED)]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["rotated", "unchanged"]);
    expect(await stored()).toHaveLength(1);
  });

  it("never stores the secret itself", async () => {
    await checkAuthSecret(SECRET);

    const rows = await stored();
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});
