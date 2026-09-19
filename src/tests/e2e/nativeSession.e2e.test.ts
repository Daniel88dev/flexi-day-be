import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { base32 } from "@better-auth/utils/base32";
import { db } from "../../db/db.js";
import { session as sessionTable, user, verification } from "../../db/schema/auth-schema.js";
import { auth } from "../../utils/auth.js";
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
  });
});
