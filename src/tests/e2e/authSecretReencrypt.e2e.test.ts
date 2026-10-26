import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { generateId } from "better-auth";
import { symmetricDecrypt, symmetricEncrypt, type SecretConfig } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { account, twoFactor, user } from "../../db/schema/auth-schema.js";
import {
  calendarConnection,
  calendarProvider,
} from "../../db/schema/calendar-connection-schema.js";
import { reencryptToCurrentVersion } from "../../services/authSecret/reencryptServices.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const V1 = "first-secret-Vq7Rz2mWb9XfT4nLp8VdC3sHy6JgA1eE";
const V2 = "second-secret-Kx3Jm9VqT2mWb8YfR5nLp1DcZ7sHg4Ae";
const V3 = "third-secret-Lp5Tn2WqZ8cRm4YvB7xKd1HsJ9gFe3Ua";

const keys = (...versions: [number, string][]): SecretConfig => ({
  keys: new Map(versions),
  currentVersion: versions[0]![0],
  legacySecret: versions.find(([v]) => v === 1)?.[1],
});

/** `BETTER_AUTH_SECRETS=2:<v2>,1:<v1>`, the first rotation after versioning. */
const ROTATED = keys([2, V2], [1, V1]);
/** The second rotation: version 1, and with it the pre-versioning key, are gone. */
const ROTATED_AGAIN = keys([3, V3], [2, V2]);

/** How the app wrote before versioning: bare hex under the lone secret. */
const legacy = (data: string) => symmetricEncrypt({ key: V1, data });

const seedUser = async () => {
  const userId = generateId();
  await db.insert(user).values({
    id: userId,
    name: "Rotation Subject",
    email: `rotation-${userId.toLowerCase()}@report-e2e.test`,
    emailVerified: true,
  });
  return userId;
};

describe("re-encrypting onto the current secret version", () => {
  beforeEach(cleanupTestData);
  afterAll(cleanupTestData);

  it("moves TOTP secrets, backup codes and calendar tokens off a key the next rotation drops", async () => {
    const userId = await seedUser();
    const twoFactorId = generateId();
    await db.insert(twoFactor).values({
      id: twoFactorId,
      userId,
      secret: await legacy("totp-secret"),
      backupCodes: await symmetricEncrypt({ key: keys([1, V1]), data: '["code-1","code-2"]' }),
    });
    const connectionId = generateId();
    await db.insert(calendarConnection).values({
      id: connectionId,
      userId,
      provider: calendarProvider.Google,
      refreshTokenEnc: await legacy("calendar-refresh"),
      accessTokenEnc: await legacy("calendar-access"),
      grantedScopes: "calendar.events",
    });

    expect(await reencryptToCurrentVersion(ROTATED)).toEqual({ reencrypted: 4, unreadable: {} });

    const [factor] = await db.select().from(twoFactor).where(eq(twoFactor.id, twoFactorId));
    const [connection] = await db
      .select()
      .from(calendarConnection)
      .where(eq(calendarConnection.id, connectionId));
    const read = (data: string | null | undefined) =>
      symmetricDecrypt({ key: ROTATED_AGAIN, data: data ?? "" });

    expect(factor?.secret).toMatch(/^\$ba\$2\$/);
    expect(await read(factor?.secret)).toBe("totp-secret");
    expect(await read(factor?.backupCodes)).toBe('["code-1","code-2"]');
    expect(await read(connection?.refreshTokenEnc)).toBe("calendar-refresh");
    expect(await read(connection?.accessTokenEnc)).toBe("calendar-access");
  });

  it("re-encrypts account tokens and leaves the plaintext ones from before encryption alone", async () => {
    const userId = await seedUser();
    const accountId = generateId();
    await db.insert(account).values({
      id: accountId,
      userId,
      accountId: `google-${accountId}`,
      providerId: "google",
      accessToken: "ya29.plaintext-from-before-encryption",
      refreshToken: await legacy("google-refresh"),
      updatedAt: new Date(),
    });

    expect(await reencryptToCurrentVersion(ROTATED)).toEqual({ reencrypted: 1, unreadable: {} });

    const [row] = await db.select().from(account).where(eq(account.id, accountId));
    expect(row?.accessToken).toBe("ya29.plaintext-from-before-encryption");
    expect(await symmetricDecrypt({ key: ROTATED_AGAIN, data: row?.refreshToken ?? "" })).toBe(
      "google-refresh"
    );
  });

  it("reports a row no held key opens and leaves it untouched", async () => {
    const userId = await seedUser();
    const stranger = await symmetricEncrypt({
      key: keys([7, "a-key-this-deployment-never-held-Zq8Wm3Rt"]),
      data: "x",
    });
    await db.insert(twoFactor).values({
      id: generateId(),
      userId,
      secret: stranger,
      backupCodes: await symmetricEncrypt({ key: ROTATED, data: "[]" }),
    });

    const result = await reencryptToCurrentVersion(ROTATED);

    expect(result.reencrypted).toBe(0);
    expect(Object.keys(result.unreadable)).toEqual(["two_factor.secret"]);
    const [row] = await db.select().from(twoFactor).where(eq(twoFactor.userId, userId));
    expect(row?.secret).toBe(stranger);
  });

  it("finds nothing to do on the next boot", async () => {
    const userId = await seedUser();
    await db.insert(twoFactor).values({
      id: generateId(),
      userId,
      secret: await legacy("totp-secret"),
      backupCodes: await legacy("[]"),
    });

    await reencryptToCurrentVersion(ROTATED);

    expect(await reencryptToCurrentVersion(ROTATED)).toEqual({ reencrypted: 0, unreadable: {} });
  });
});
