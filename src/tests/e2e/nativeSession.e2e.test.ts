import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { base32 } from "@better-auth/utils/base32";
import { db } from "../../db/db.js";
import { session as sessionTable, user, verification } from "../../db/schema/auth-schema.js";
import { auth } from "../../utils/auth.js";
import { logger } from "../../middleware/logger.js";
import { SESSION_DEVICE_MISMATCH } from "../../utils/nativeSession.js";
import { createServer } from "../../server.js";
import { WEB_TEST_PASSWORD, authCookieFor, createWebUser } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const APP_SCHEME = "flexiday://";
const BROWSER_ORIGIN = "http://localhost:3000";
const SESSION_COOKIE = "better-auth.session_token";
const TRUST_DEVICE_COOKIE = "better-auth.trust_device";

const setCookiesOf = (res: request.Response): string[] =>
  (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];

/**
 * The last `Set-Cookie` entry for a name wins in every client, which is what
 * lets the after hook re-issue the session cookie the endpoint already wrote.
 */
const lastCookie = (res: request.Response, name: string): string | undefined =>
  setCookiesOf(res)
    .filter((entry) => entry.startsWith(`${name}=`))
    .at(-1);

/**
 * No `Max-Age` and no `Expires` is what a phone's session cookie looks like: a
 * cookie cannot say ten years, so it says nothing and the row decides.
 */
const expectNoCookieExpiry = (res: request.Response, name: string) => {
  const cookie = lastCookie(res, name);
  expect(cookie).toBeDefined();
  expect(cookie).not.toMatch(/max-age=/i);
  expect(cookie).not.toMatch(/expires=/i);
};

/** A `Cookie` header from a response, last value per name, as a client sends. */
const cookieHeaderOf = (res: request.Response): string => {
  const jar = new Map<string, string>();
  for (const entry of setCookiesOf(res)) {
    const [pair] = entry.split(";");
    const name = pair?.split("=")[0];
    if (name && pair) jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
};

const sessionsOf = (userId: string) =>
  db.select().from(sessionTable).where(eq(sessionTable.userId, userId));

const yearsUntil = (date: Date) => (date.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000);

/**
 * A ten-year session stamped with the phone that opened it, and a web sign-in
 * left exactly as it was. Runs against a real database.
 */
describe("native session", () => {
  let app: Express;

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  const deviceId = () => `device-${uuidv4()}`;

  const signIn = (email: string, headers: Record<string, string> = {}) => {
    const req = request(app).post("/api/auth/sign-in/email");
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req.send({ email, password: WEB_TEST_PASSWORD });
  };

  const nativeHeaders = (device: string, extra: Record<string, string> = {}) => ({
    "expo-origin": APP_SCHEME,
    "x-client-device-id": device,
    ...extra,
  });

  it("stamps the phone on the row and hands it a cookie that never expires", async () => {
    const device = deviceId();
    const { id, email } = await createWebUser("Native Sign In Subject");

    const res = await signIn(
      email,
      nativeHeaders(device, {
        "x-client-platform": "ios",
        "x-client-app-version": "1.2.3+45",
      })
    );

    expect(res.status).toBe(200);
    const rows = await sessionsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceId: device,
      platform: "ios",
      appVersion: "1.2.3+45",
    });
    expect(yearsUntil(rows[0]!.expiresAt)).toBeGreaterThan(9.9);
    expectNoCookieExpiry(res, SESSION_COOKIE);
  });

  it("signs the phone in anyway when the platform and version are unusable", async () => {
    const device = deviceId();
    const { id, email } = await createWebUser("Native Malformed Subject");

    const res = await signIn(
      email,
      nativeHeaders(device, {
        "x-client-platform": "windows-phone",
        "x-client-app-version": "1.0.0 (drop table user)",
      })
    );

    expect(res.status).toBe(200);
    const rows = await sessionsOf(id);
    expect(rows[0]).toMatchObject({ deviceId: device, platform: null, appVersion: null });
    expectNoCookieExpiry(res, SESSION_COOKIE);
  });

  it("leaves the columns null when the phone sends no platform or version", async () => {
    const device = deviceId();
    const { id, email } = await createWebUser("Native Bare Subject");

    const res = await signIn(email, nativeHeaders(device));

    expect(res.status).toBe(200);
    const rows = await sessionsOf(id);
    expect(rows[0]).toMatchObject({ deviceId: device, platform: null, appVersion: null });
  });

  it("takes the earlier session's place when the same phone signs in again", async () => {
    const device = deviceId();
    const { id, email } = await createWebUser("Same Device Subject");

    const first = await signIn(email, nativeHeaders(device));
    expect(first.status).toBe(200);
    const [replaced] = await sessionsOf(id);

    const second = await signIn(email, nativeHeaders(device));
    expect(second.status).toBe(200);

    const rows = await sessionsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(replaced!.id);
    expect(rows[0]).toMatchObject({ deviceId: device });

    const stale = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", cookieHeaderOf(first))
      .set("x-client-device-id", device);
    expect(stale.status).toBe(200);
    expect(stale.body?.user).toBeFalsy();
  });

  it("leaves the other phone signed in when a second device signs in", async () => {
    const phone = deviceId();
    const tablet = deviceId();
    const { id, email } = await createWebUser("Two Device Subject");

    expect((await signIn(email, nativeHeaders(phone))).status).toBe(200);
    expect((await signIn(email, nativeHeaders(tablet))).status).toBe(200);

    const rows = await sessionsOf(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.deviceId).sort()).toEqual([phone, tablet].sort());
  });

  it("replaces the session on the phone even when someone else signs in", async () => {
    const device = deviceId();
    const first = await createWebUser("Handed Over Phone Subject");
    const second = await createWebUser("Handed The Phone Subject");

    expect((await signIn(first.email, nativeHeaders(device))).status).toBe(200);
    expect((await signIn(second.email, nativeHeaders(device))).status).toBe(200);

    // The device id is the key, never the user: one phone, one session, no
    // matter whose account it is.
    expect(await sessionsOf(first.id)).toHaveLength(0);
    expect(await sessionsOf(second.id)).toHaveLength(1);
  });

  it("changes nothing about a web sign-in", async () => {
    const { id, email } = await createWebUser("Web Sign In Subject");

    const res = await signIn(email, { Origin: BROWSER_ORIGIN });

    expect(res.status).toBe(200);
    const rows = await sessionsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId: null, platform: null, appVersion: null });
    expect(yearsUntil(rows[0]!.expiresAt)).toBeLessThan(0.1);
    expect(lastCookie(res, SESSION_COOKIE)).toContain("Max-Age=604800");
  });

  it("ignores a sign-in body that tries to stamp the fields itself", async () => {
    const { id, email } = await createWebUser("Body Forger Subject");

    const res = await request(app)
      .post("/api/auth/sign-in/email")
      .set("Origin", BROWSER_ORIGIN)
      .send({
        email,
        password: WEB_TEST_PASSWORD,
        deviceId: "forged-device-id",
        platform: "ios",
        appVersion: "9.9.9",
      });

    expect(res.status).toBe(200);
    const rows = await sessionsOf(id);
    expect(rows[0]).toMatchObject({ deviceId: null, platform: null, appVersion: null });
    expect(lastCookie(res, SESSION_COOKIE)).toContain("Max-Age=604800");
  });

  it("still revokes a native session when the password is reset", async () => {
    const device = deviceId();
    const { id, email } = await createWebUser("Reset Subject");

    const signedIn = await signIn(email, nativeHeaders(device));
    expect(signedIn.status).toBe(200);
    expect(await sessionsOf(id)).toHaveLength(1);

    // The endpoint as a plain function, which skips the hooks — the same seam
    // the settle suite uses, and the only way past the haveIBeenPwned check's
    // outbound call. `revokeSessionsOnPasswordReset` lives in the handler.
    const token = `tok-${uuidv4()}`;
    await db.insert(verification).values({
      id: uuidv4(),
      identifier: `reset-password:${token}`,
      value: id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await auth.api.resetPassword({ body: { newPassword: "Str0ng-Reset-Pass-9182", token } });

    // A ten-year row would otherwise outlive the phone it was lost with.
    expect(await sessionsOf(id)).toHaveLength(0);
    const after = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", cookieHeaderOf(signedIn));
    expect(after.body?.user).toBeFalsy();
  });

  describe("with two-factor in the way", () => {
    let userId: string;
    let email: string;
    let totpSecret: string;

    const totpCode = async () => {
      const raw = new TextDecoder().decode(base32.decode(totpSecret));
      const { code } = await auth.api.generateTOTP({ body: { secret: raw } });
      return code;
    };

    beforeAll(async () => {
      ({ id: userId, email } = await createWebUser("Native Two Factor Subject"));

      // Enrollment from a browser session, the way a person actually does it.
      const cookie = await authCookieFor(userId);
      const enable = await request(app)
        .post("/api/auth/two-factor/enable")
        .set("Origin", BROWSER_ORIGIN)
        .set("Cookie", cookie)
        .send({ password: WEB_TEST_PASSWORD });
      expect(enable.status).toBe(200);
      totpSecret = new URL(enable.body.totpURI as string).searchParams.get("secret") ?? "";

      const verified = await request(app)
        .post("/api/auth/two-factor/verify-totp")
        .set("Origin", BROWSER_ORIGIN)
        .set("Cookie", cookie)
        .send({ code: await totpCode() });
      expect(verified.status).toBe(200);
      const [row] = await db.select().from(user).where(eq(user.id, userId));
      expect(row?.twoFactorEnabled).toBe(true);

      await db.delete(sessionTable).where(eq(sessionTable.userId, userId));
    });

    it("stamps the session the second factor finally hands over", async () => {
      const device = deviceId();

      const challenge = await signIn(email, nativeHeaders(device));
      expect(challenge.body.twoFactorRedirect).toBe(true);
      // The pre-challenge session dies with the redirect, as it does on the web.
      expect(await sessionsOf(userId)).toHaveLength(0);

      const res = await request(app)
        .post("/api/auth/two-factor/verify-totp")
        .set(nativeHeaders(device))
        .set("Cookie", cookieHeaderOf(challenge))
        .send({ code: await totpCode() });

      expect(res.status).toBe(200);
      const rows = await sessionsOf(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deviceId: device });
      expect(yearsUntil(rows[0]!.expiresAt)).toBeGreaterThan(9.9);
      expectNoCookieExpiry(res, SESSION_COOKIE);

      await db.delete(sessionTable).where(eq(sessionTable.userId, userId));
    });

    it("stands through a challenge, and is replaced by the session that ends it", async () => {
      const device = deviceId();

      const opened = await signIn(email, nativeHeaders(device));
      const established = await request(app)
        .post("/api/auth/two-factor/verify-totp")
        .set(nativeHeaders(device))
        .set("Cookie", cookieHeaderOf(opened))
        .send({ code: await totpCode() });
      expect(established.status).toBe(200);
      const [standing] = await sessionsOf(userId);
      expect(standing).toBeDefined();

      const challenge = await signIn(email, nativeHeaders(device));
      expect(challenge.body.twoFactorRedirect).toBe(true);

      // The throwaway pre-challenge session must not knock the phone out, so
      // walking away from the code here costs the person nothing.
      const during = await sessionsOf(userId);
      expect(during).toHaveLength(1);
      expect(during[0]!.id).toBe(standing!.id);

      const verified = await request(app)
        .post("/api/auth/two-factor/verify-totp")
        .set(nativeHeaders(device))
        .set("Cookie", cookieHeaderOf(challenge))
        .send({ code: await totpCode() });
      expect(verified.status).toBe(200);

      const rows = await sessionsOf(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).not.toBe(standing!.id);
      expect(rows[0]).toMatchObject({ deviceId: device });

      await db.delete(sessionTable).where(eq(sessionTable.userId, userId));
    });

    it("stamps the pre-challenge session too, which a trusted device keeps", async () => {
      const device = deviceId();

      const challenge = await signIn(email, nativeHeaders(device));
      const trusted = await request(app)
        .post("/api/auth/two-factor/verify-totp")
        .set(nativeHeaders(device))
        .set("Cookie", cookieHeaderOf(challenge))
        .send({ code: await totpCode(), trustDevice: true });
      expect(trusted.status).toBe(200);

      const trustCookie = lastCookie(trusted, TRUST_DEVICE_COOKIE)?.split(";")[0];
      expect(trustCookie).toBeDefined();
      await db.delete(sessionTable).where(eq(sessionTable.userId, userId));

      // The trusted device skips the challenge, so the session the sign-in
      // endpoint created is never thrown away — it is the one the phone keeps,
      // and the create hook's stamp on it has to be right.
      const res = await signIn(email, nativeHeaders(device)).set("Cookie", trustCookie!);

      expect(res.status).toBe(200);
      expect(res.body.twoFactorRedirect).toBeUndefined();
      const rows = await sessionsOf(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deviceId: device });
      expect(yearsUntil(rows[0]!.expiresAt)).toBeGreaterThan(9.9);
      expectNoCookieExpiry(res, SESSION_COOKIE);
    });

    /**
     * The `send-otp` limiter needed nothing of its own for the phone, which is
     * a claim worth driving rather than reading: the expo client forwards its
     * cookie jar as a `Cookie` header, so a real native challenge keys on that
     * cookie exactly as a browser does, and two phones behind one NAT never
     * pool into a single budget.
     */
    it("keys a native request on the cookie it carries, not on its IP", async () => {
      const sendOtp = (challenge: request.Response, device: string) =>
        request(app)
          .post("/api/auth/two-factor/send-otp")
          .set(nativeHeaders(device))
          .set("Cookie", cookieHeaderOf(challenge))
          .send({});

      const budgetOf = (res: request.Response) => ({
        limit: Number(res.headers["ratelimit-limit"]),
        remaining: Number(res.headers["ratelimit-remaining"]),
      });

      const device = deviceId();
      const challenge = await signIn(email, nativeHeaders(device));
      expect(challenge.body.twoFactorRedirect).toBe(true);

      const first = budgetOf(await sendOtp(challenge, device));
      const repeat = budgetOf(await sendOtp(challenge, device));

      // Mounted last of the limiters on this path, so these headers are its
      // own: a fresh budget for this challenge, spent one request at a time.
      expect(first.remaining).toBe(first.limit - 1);
      expect(repeat.remaining).toBe(first.remaining - 1);

      // Same IP, same phone, a second challenge: a budget of its own, which an
      // IP-keyed limiter could not hand it.
      const second = await signIn(email, nativeHeaders(deviceId()));
      expect(second.body.twoFactorRedirect).toBe(true);
      const elsewhere = budgetOf(await sendOtp(second, device));

      expect(elsewhere.remaining).toBe(first.remaining);
    });
  });

  /**
   * The check itself, driven over HTTP on both surfaces it has to hold on:
   * better-auth's own endpoints and the app's routes behind `authSession`.
   */
  describe("on every later request", () => {
    // Any route behind `authSession` would do; this one needs no fixtures.
    const PROTECTED_ROUTE = "/api/notifications";

    const MALFORMED_DEVICE_ID = "short";

    const boundSession = async (device: string, name: string) => {
      const { id, email } = await createWebUser(name);
      const res = await signIn(email, nativeHeaders(device));
      expect(res.status).toBe(200);
      return { id, cookie: cookieHeaderOf(res) };
    };

    const getSession = (cookie: string, headers: Record<string, string> = {}) =>
      request(app).get("/api/auth/get-session").set("Cookie", cookie).set(headers);

    const protectedRoute = (cookie: string, headers: Record<string, string> = {}) =>
      request(app).get(PROTECTED_ROUTE).set("Cookie", cookie).set(headers);

    /** Every shape of the header a browser could send by mistake. */
    const strayHeaders = () => [
      {},
      { "x-client-device-id": deviceId() },
      { "x-client-device-id": MALFORMED_DEVICE_ID },
    ];

    /** An unbound session answers as it always did, on both surfaces, and survives. */
    const expectUnaffected = async (id: string, cookie: string) => {
      for (const headers of strayHeaders()) {
        const session = await getSession(cookie, headers);
        expect(session.status).toBe(200);
        expect(session.body?.user?.id).toBe(id);

        const route = await protectedRoute(cookie, headers);
        expect(route.status).toBe(200);
      }

      expect(await sessionsOf(id)).toHaveLength(1);
    };

    it("answers the phone that opened it, on both surfaces", async () => {
      const device = deviceId();
      const { id, cookie } = await boundSession(device, "Device Match Subject");

      const session = await getSession(cookie, { "x-client-device-id": device });
      expect(session.status).toBe(200);
      expect(session.body?.user?.id).toBe(id);

      const route = await protectedRoute(cookie, { "x-client-device-id": device });
      expect(route.status).toBe(200);

      expect(await sessionsOf(id)).toHaveLength(1);
    });

    it("ends the session when another device presents its cookie", async () => {
      const device = deviceId();
      const { id, cookie } = await boundSession(device, "Device Mismatch Subject");
      const warn = vi.spyOn(logger, "warn");
      const intruder = deviceId();

      const res = await getSession(cookie, { "x-client-device-id": intruder });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(SESSION_DEVICE_MISMATCH);
      expect(await sessionsOf(id)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        "session.device_mismatch",
        expect.objectContaining({
          "user.id": id,
          "session.device_id": device,
          "request.device_id": intruder,
        })
      );
      warn.mockRestore();

      // Deleted, not merely refused, so the right id cannot win it back.
      const retry = await getSession(cookie, { "x-client-device-id": device });
      expect(retry.status).toBe(200);
      expect(retry.body?.user).toBeFalsy();
    });

    it("ends the session when the cookie arrives with no device id", async () => {
      const device = deviceId();
      const { id, cookie } = await boundSession(device, "Device Absent Subject");
      const warn = vi.spyOn(logger, "warn");

      const res = await getSession(cookie);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(SESSION_DEVICE_MISMATCH);
      expect(await sessionsOf(id)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        "session.device_mismatch",
        expect.objectContaining({ "session.device_id": device, "request.device_id": null })
      );
      warn.mockRestore();
    });

    it("treats a malformed device id as no device id at all", async () => {
      const device = deviceId();
      const { id, cookie } = await boundSession(device, "Device Malformed Subject");

      const res = await getSession(cookie, { "x-client-device-id": MALFORMED_DEVICE_ID });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(SESSION_DEVICE_MISMATCH);
      expect(await sessionsOf(id)).toHaveLength(0);
    });

    it("answers a protected API route with the same code", async () => {
      const device = deviceId();
      const { id, cookie } = await boundSession(device, "Device Mismatch Route Subject");

      const res = await protectedRoute(cookie, { "x-client-device-id": deviceId() });

      expect(res.status).toBe(401);
      expect(res.body.errors?.[0]?.context?.code).toBe(SESSION_DEVICE_MISMATCH);
      expect(await sessionsOf(id)).toHaveLength(0);
    });

    it("leaves a web session alone whatever device id header it carries", async () => {
      const { id, email } = await createWebUser("Web Stray Header Subject");
      const signedIn = await signIn(email, { Origin: BROWSER_ORIGIN });
      expect(signedIn.status).toBe(200);

      await expectUnaffected(id, cookieHeaderOf(signedIn));
    });

    it("leaves a dev-login session alone the same way", async () => {
      const { id } = await createWebUser("Dev Login Stray Header Subject");

      await expectUnaffected(id, await authCookieFor(id));
    });
  });
});
