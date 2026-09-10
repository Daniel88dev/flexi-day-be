import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { base32 } from "@better-auth/utils/base32";
import { db } from "../../db/db.js";
import { account, twoFactor as twoFactorTable, user } from "../../db/schema/auth-schema.js";
import { auth } from "../../utils/auth.js";
import { createServer } from "../../server.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";

// Captures the OTP the plugin hands to sendOTP, so the emailed-code path can
// be driven end to end without a mailbox. Everything else in this file works
// against the real flow — no other endpoint sends mail.
const sentEmails: { to: string; template: string; data: Record<string, string> }[] = [];
vi.mock("../../services/email/index.js", () => ({
  emailSender: {
    sendTemplated: (email: (typeof sentEmails)[number]) => {
      sentEmails.push(email);
      return Promise.resolve();
    },
  },
}));

/**
 * The full second-factor loop over HTTP: enrollment gated on the password,
 * the sign-in interstitial, TOTP and backup-code verification, and disable.
 * Runs against a real database.
 */
describe("two-factor authentication", () => {
  let app: Express;
  const password = "sturdy-passphrase-42";
  const email = `twofactor-${uuidv4()}@dev.local`;
  let userId: string;
  let totpSecret: string;
  let backupCodes: string[];

  const cookiesOf = (res: request.Response): string =>
    (res.headers["set-cookie"] as unknown as string[] | undefined)
      ?.map((c) => c.split(";")[0])
      .join("; ") ?? "";

  const totpCode = async () => {
    // The URI carries the base32 encoding an authenticator app scans;
    // generateTOTP wants the raw secret, exactly as the app would derive it.
    const raw = new TextDecoder().decode(base32.decode(totpSecret));
    const { code } = await auth.api.generateTOTP({ body: { secret: raw } });
    return code;
  };

  const signIn = () => request(app).post("/api/auth/sign-in/email").send({ email, password });

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();
    userId = uuidv4();
    await db.insert(user).values({
      id: userId,
      email,
      name: "Two Factor Subject",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(account).values({
      id: uuidv4(),
      userId,
      providerId: "credential",
      accountId: userId,
      password: await hashPassword(password),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("refuses to start enrollment with a wrong password", async () => {
    const cookie = await authCookieFor(userId);
    const res = await request(app)
      .post("/api/auth/two-factor/enable")
      .set("Cookie", cookie)
      .send({ password: "not-the-password" });

    // Pinned (not >= 400): a 429 from the shared credentialsLimiter store
    // would otherwise satisfy this without proving the password check.
    expect(res.status).toBe(400);
    const rows = await db.select().from(twoFactorTable).where(eq(twoFactorTable.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("hands out the TOTP URI and backup codes without flipping the flag yet", async () => {
    const cookie = await authCookieFor(userId);
    const res = await request(app)
      .post("/api/auth/two-factor/enable")
      .set("Cookie", cookie)
      .send({ password });

    expect(res.status).toBe(200);
    expect(res.body.totpURI).toContain("otpauth://totp/");
    // The QR must name the product, not the library.
    expect(res.body.totpURI).toContain("issuer=Flexi+Day");
    expect(res.body.backupCodes).toHaveLength(10);
    totpSecret = new URL(res.body.totpURI).searchParams.get("secret") ?? "";
    expect(totpSecret).not.toBe("");
    backupCodes = res.body.backupCodes;

    // Enrollment is not proven yet, so sign-in must stay single-factor.
    const [row] = await db.select().from(user).where(eq(user.id, userId));
    expect(row?.twoFactorEnabled).toBeFalsy();
  });

  it("activates 2FA once a TOTP code proves the authenticator", async () => {
    const cookie = await authCookieFor(userId);
    const res = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("Cookie", cookie)
      .send({ code: await totpCode() });

    expect(res.status).toBe(200);
    const [row] = await db.select().from(user).where(eq(user.id, userId));
    expect(row?.twoFactorEnabled).toBe(true);
  });

  it("interrupts password sign-in with a 2FA challenge instead of a session", async () => {
    const res = await signIn();

    expect(res.status).toBe(200);
    expect(res.body.twoFactorRedirect).toBe(true);
    // No session cookie yet — only the short-lived challenge cookie.
    expect(cookiesOf(res)).toContain("two_factor");
  });

  it("rejects a wrong code and accepts a fresh TOTP for the real session", async () => {
    const challenge = await signIn();
    const challengeCookies = cookiesOf(challenge);

    const wrong = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("Cookie", challengeCookies)
      .send({ code: "000000" });
    expect(wrong.status).toBe(401);

    const right = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("Cookie", challengeCookies)
      .send({ code: await totpCode() });
    expect(right.status).toBe(200);

    const sessionCookies = cookiesOf(right);
    expect(sessionCookies).toContain("session_token");
    const me = await request(app).get("/api/auth/get-session").set("Cookie", sessionCookies);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
  });

  it("accepts a backup code exactly once", async () => {
    const first = await signIn();
    const res = await request(app)
      .post("/api/auth/two-factor/verify-backup-code")
      .set("Cookie", cookiesOf(first))
      .send({ code: backupCodes[0] });
    expect(res.status).toBe(200);
    expect(cookiesOf(res)).toContain("session_token");

    const second = await signIn();
    const replay = await request(app)
      .post("/api/auth/two-factor/verify-backup-code")
      .set("Cookie", cookiesOf(second))
      .send({ code: backupCodes[0] });
    expect(replay.status).toBe(401);
  });

  it("enrolls and signs in with an emailed code alone", async () => {
    // A second user who never scans the QR — the email-only path.
    const otpEmail = `twofactor-otp-${uuidv4()}@dev.local`;
    const otpUserId = uuidv4();
    await db.insert(user).values({
      id: otpUserId,
      email: otpEmail,
      name: "Email Only Subject",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(account).values({
      id: uuidv4(),
      userId: otpUserId,
      providerId: "credential",
      accountId: otpUserId,
      password: await hashPassword(password),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lastCode = () => {
      const email = sentEmails.at(-1);
      if (!email) throw new Error("no OTP email captured");
      expect(email.to).toBe(otpEmail);
      expect(email.template).toBe("two-factor-code");
      return email.data.code;
    };

    // Enroll: enable, then prove the address instead of an authenticator.
    const cookie = await authCookieFor(otpUserId);
    const en = await request(app)
      .post("/api/auth/two-factor/enable")
      .set("Cookie", cookie)
      .send({ password });
    expect(en.status).toBe(200);
    const send = await request(app)
      .post("/api/auth/two-factor/send-otp")
      .set("Cookie", cookie)
      .send({});
    expect(send.status).toBe(200);
    const verify = await request(app)
      .post("/api/auth/two-factor/verify-otp")
      .set("Cookie", cookie)
      .send({ code: lastCode() });
    expect(verify.status).toBe(200);
    const [row] = await db.select().from(user).where(eq(user.id, otpUserId));
    expect(row?.twoFactorEnabled).toBe(true);

    // Sign-in offers only the emailed code — the authenticator was never
    // proven, so the row is unverified and totp must not be listed.
    const challenge = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: otpEmail, password });
    expect(challenge.body.twoFactorRedirect).toBe(true);
    expect(challenge.body.twoFactorMethods).toContain("otp");
    expect(challenge.body.twoFactorMethods).not.toContain("totp");

    const challengeCookies = cookiesOf(challenge);
    const resend = await request(app)
      .post("/api/auth/two-factor/send-otp")
      .set("Cookie", challengeCookies)
      .send({});
    expect(resend.status).toBe(200);
    const signedIn = await request(app)
      .post("/api/auth/two-factor/verify-otp")
      .set("Cookie", challengeCookies)
      .send({ code: lastCode() });
    expect(signedIn.status).toBe(200);
    expect(cookiesOf(signedIn)).toContain("session_token");
  });

  it("restores single-factor sign-in when 2FA is disabled with the password", async () => {
    const cookie = await authCookieFor(userId);
    const res = await request(app)
      .post("/api/auth/two-factor/disable")
      .set("Cookie", cookie)
      .send({ password });
    expect(res.status).toBe(200);

    const signin = await signIn();
    expect(signin.status).toBe(200);
    expect(signin.body.twoFactorRedirect).toBeUndefined();
    expect(cookiesOf(signin)).toContain("session_token");

    const rows = await db.select().from(twoFactorTable).where(eq(twoFactorTable.userId, userId));
    expect(rows).toHaveLength(0);
  });
});
