import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { createLocalAccountIssuer, createOAuthAccountIssuer } from "better-auth/db";
import { account, user, verification } from "../../db/schema/auth-schema.js";
import { auth } from "../../utils/auth.js";
import { cleanupTestData } from "./helpers/testSetup.js";

/**
 * `onPasswordReset` is the one place that grants a verified address without a
 * confirmation-email click, so what it does and does not carry over matters
 * more than anything else in the reset flow. Runs against a real database.
 */
describe("password reset settles the account", () => {
  const settle = async (id: string) => {
    const [row] = await db.select().from(user).where(eq(user.id, id));
    if (!row) throw new Error("test user vanished");
    const hook = auth.options.emailAndPassword?.onPasswordReset;
    if (!hook) throw new Error("onPasswordReset is not configured");
    await hook({ user: row }, undefined);
  };

  const makeUser = async (emailVerified: boolean) => {
    const id = uuidv4();
    await db.insert(user).values({
      id,
      email: `reset-${id}@dev.local`,
      name: "Reset Subject",
      emailVerified,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  };

  const addAccount = async (userId: string, providerId: string) => {
    await db.insert(account).values({
      id: uuidv4(),
      userId,
      providerId,
      issuer:
        providerId === "credential"
          ? createLocalAccountIssuer(providerId)
          : createOAuthAccountIssuer(providerId),
      accountId: `${providerId}-${userId}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  const accountsOf = async (userId: string) =>
    (await db.select().from(account).where(eq(account.userId, userId)))
      .map((a) => a.providerId)
      .sort();

  const isVerified = async (userId: string) =>
    (await db.select().from(user).where(eq(user.id, userId)))[0]?.emailVerified;

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("verifies the address, so the new password is usable", async () => {
    const id = await makeUser(false);
    await addAccount(id, "credential");

    await settle(id);

    // `requireEmailVerification` would otherwise reject the sign-in the user
    // just set a password for.
    expect(await isVerified(id)).toBe(true);
  });

  it("drops provider logins attached before anyone proved the address", async () => {
    const id = await makeUser(false);
    await addAccount(id, "credential");
    await addAccount(id, "microsoft");
    await addAccount(id, "google");

    await settle(id);

    // A directory administrator can create this row by asserting an address
    // they do not own. Social sign-in is not gated on `requireEmailVerification`,
    // so leaving it attached would hand them the account the real owner just
    // proved and verified.
    expect(await accountsOf(id)).toEqual(["credential"]);
    expect(await isVerified(id)).toBe(true);
  });

  it("leaves an already-verified account entirely alone", async () => {
    const id = await makeUser(true);
    await addAccount(id, "credential");
    await addAccount(id, "google");

    await settle(id);

    // Here the links were made from a signed-in session on a proven address,
    // so an ordinary password reset must not silently disconnect them.
    expect(await accountsOf(id)).toEqual(["credential", "google"]);
    expect(await isVerified(id)).toBe(true);
  });

  it("never leaves an account with no way to sign in", async () => {
    // Drives the real endpoint, not the hook: the delete is only safe because
    // better-auth writes the `credential` row *before* calling `onPasswordReset`.
    // If a future upgrade flips that order, a social-only user's reset would
    // remove their last account and lock them out permanently — and a test that
    // called the hook directly would stay green through it.
    const id = await makeUser(false);
    await addAccount(id, "microsoft");

    const token = `tok-${uuidv4()}`;
    await db.insert(verification).values({
      id: uuidv4(),
      identifier: `reset-password:${token}`,
      value: id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await auth.api.resetPassword({
      body: { newPassword: "Str0ng-Reset-Pass-9182", token },
    });

    expect(await accountsOf(id)).toEqual(["credential"]);
    expect(await isVerified(id)).toBe(true);
  });

  it("touches nobody else's account", async () => {
    const subject = await makeUser(false);
    await addAccount(subject, "microsoft");
    const bystander = await makeUser(false);
    await addAccount(bystander, "microsoft");

    await settle(subject);

    // A missing WHERE here would verify every account in the database and
    // unlock email-bound invite redemption for all of them.
    expect(await accountsOf(bystander)).toEqual(["microsoft"]);
    expect(await isVerified(bystander)).toBe(false);
  });
});
