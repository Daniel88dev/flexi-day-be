import { describe, it, expect, beforeAll, afterAll, vi, type MockInstance } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { base32 } from "@better-auth/utils/base32";
import { db } from "../../db/db.js";
import { verification } from "../../db/schema/auth-schema.js";
import { auth } from "../../utils/auth.js";
import { pushRegistrations } from "../../db/schema/push-registration-schema.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { WEB_TEST_PASSWORD, authCookieFor, createWebUser } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { cookieHeaderOf, nativeHeaders, sessionsOf } from "./helpers/nativeSessionHelpers.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ROUTE = "/api/users/me/push-registration";
const BROWSER_ORIGIN = "http://localhost:3000";

const apnsToken = () => uuidv4().replace(/-/g, "").repeat(2);

describe("push registration", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  const signInPhone = async (name: string) => {
    const device = `device-${uuidv4()}`;
    const { id, email } = await createWebUser(name);
    const res = await request(server.url)
      .post("/api/auth/sign-in/email")
      .set(nativeHeaders(device))
      .send({ email, password: WEB_TEST_PASSWORD });
    expect(res.status).toBe(200);
    const [row] = await sessionsOf(id);
    return { userId: id, email, device, cookie: cookieHeaderOf(res), sessionId: row!.id };
  };

  const register = (
    phone: { device: string; cookie: string },
    body: Record<string, unknown> = { token: apnsToken(), environment: "sandbox" }
  ) =>
    request(server.url)
      .put(ROUTE)
      .set(nativeHeaders(phone.device))
      .set("Cookie", phone.cookie)
      .send(body);

  const registrationOf = async (sessionId: string) => {
    const [row] = await db
      .select()
      .from(pushRegistrations)
      .where(eq(pushRegistrations.sessionId, sessionId));
    return row;
  };

  describe("PUT", () => {
    it("registers the phone's token against its Native session", async () => {
      const phone = await signInPhone("Push Register Subject");
      const token = apnsToken();

      const res = await register(phone, { token, environment: "sandbox" });

      expect(res.status).toBe(204);
      expect(await registrationOf(phone.sessionId)).toMatchObject({
        sessionId: phone.sessionId,
        token,
        environment: "sandbox",
      });
    });

    it("writes nothing when the phone repeats the same token and environment", async () => {
      const phone = await signInPhone("Push Repeat Subject");
      const body = { token: apnsToken(), environment: "production" };
      expect((await register(phone, body)).status).toBe(204);
      const first = await registrationOf(phone.sessionId);

      const res = await register(phone, body);

      expect(res.status).toBe(204);
      const again = await registrationOf(phone.sessionId);
      expect(again).toEqual(first);
    });

    it("replaces the token when the phone hands over a new one", async () => {
      const phone = await signInPhone("Push New Token Subject");
      expect((await register(phone)).status).toBe(204);
      const token = apnsToken();

      expect((await register(phone, { token, environment: "sandbox" })).status).toBe(204);

      expect(await registrationOf(phone.sessionId)).toMatchObject({ token });
      expect(
        await db
          .select()
          .from(pushRegistrations)
          .where(eq(pushRegistrations.sessionId, phone.sessionId))
      ).toHaveLength(1);
    });

    it("replaces the environment when only that changes", async () => {
      const phone = await signInPhone("Push New Environment Subject");
      const token = apnsToken();
      expect((await register(phone, { token, environment: "sandbox" })).status).toBe(204);
      const before = await registrationOf(phone.sessionId);

      expect((await register(phone, { token, environment: "production" })).status).toBe(204);

      const after = await registrationOf(phone.sessionId);
      expect(after).toMatchObject({ token, environment: "production" });
      expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    });

    it("takes the token away from any other session that still holds it", async () => {
      const earlier = await signInPhone("Push Earlier Holder Subject");
      const later = await signInPhone("Push Later Holder Subject");
      const token = apnsToken();
      expect((await register(earlier, { token, environment: "sandbox" })).status).toBe(204);

      expect((await register(later, { token, environment: "sandbox" })).status).toBe(204);

      expect(await registrationOf(earlier.sessionId)).toBeUndefined();
      expect(await registrationOf(later.sessionId)).toMatchObject({ token });
    });

    it("refuses a web session with NATIVE_SESSION_REQUIRED and stores nothing", async () => {
      const { id } = await createWebUser("Push Web Subject");
      const cookie = await authCookieFor(id);

      const res = await request(server.url)
        .put(ROUTE)
        .set("Cookie", cookie)
        .send({ token: apnsToken(), environment: "sandbox" });

      expect(res.status).toBe(403);
      expect(res.body.errors[0].context.reason).toBe("NATIVE_SESSION_REQUIRED");
      const [webSession] = await sessionsOf(id);
      expect(await registrationOf(webSession!.id)).toBeUndefined();
    });

    it("refuses a token that is not hex", async () => {
      const phone = await signInPhone("Push Bad Token Subject");

      const res = await register(phone, { token: "not-a-token", environment: "sandbox" });

      expect(res.status).toBe(422);
      expect(await registrationOf(phone.sessionId)).toBeUndefined();
    });

    it("refuses an environment other than sandbox or production", async () => {
      const phone = await signInPhone("Push Bad Environment Subject");

      const res = await register(phone, { token: apnsToken(), environment: "development" });

      expect(res.status).toBe(422);
      expect(await registrationOf(phone.sessionId)).toBeUndefined();
    });

    it("answers 401 without a session", async () => {
      const res = await request(server.url)
        .put(ROUTE)
        .send({ token: apnsToken(), environment: "sandbox" });

      expect(res.status).toBe(401);
    });
  });

  describe("DELETE", () => {
    const unregister = (phone: { device: string; cookie: string }) =>
      request(server.url)
        .delete(ROUTE)
        .set(nativeHeaders(phone.device))
        .set("Cookie", phone.cookie);

    it("removes the phone's registration and leaves the session signed in", async () => {
      const phone = await signInPhone("Push Unregister Subject");
      expect((await register(phone)).status).toBe(204);

      const res = await unregister(phone);

      expect(res.status).toBe(204);
      expect(await registrationOf(phone.sessionId)).toBeUndefined();
      expect(await sessionsOf(phone.userId)).toHaveLength(1);
    });

    it("answers 204 when there is nothing to remove", async () => {
      const phone = await signInPhone("Push Unregister Nothing Subject");

      expect((await unregister(phone)).status).toBe(204);
    });

    it("leaves another phone's registration alone", async () => {
      const phone = await signInPhone("Push Unregister Mine Subject");
      const other = await signInPhone("Push Unregister Other Subject");
      expect((await register(phone)).status).toBe(204);
      expect((await register(other)).status).toBe(204);

      expect((await unregister(phone)).status).toBe(204);

      expect(await registrationOf(other.sessionId)).toBeDefined();
    });

    it("refuses a web session with NATIVE_SESSION_REQUIRED", async () => {
      const { id } = await createWebUser("Push Web Unregister Subject");

      const res = await request(server.url)
        .delete(ROUTE)
        .set("Cookie", await authCookieFor(id));

      expect(res.status).toBe(403);
      expect(res.body.errors[0].context.reason).toBe("NATIVE_SESSION_REQUIRED");
    });
  });

  /**
   * The invariant in `docs/invariants.md`: a session ends by deleting its row,
   * so every way one ends takes its registration with it. A session that
   * ended by a flag would leave the phone receiving the old user's notices.
   */
  describe("ends with its session", () => {
    const PWNED_RANGE = "https://api.pwnedpasswords.com/range/";

    let pwnedFetch: MockInstance<typeof fetch>;

    beforeAll(() => {
      const realFetch = globalThis.fetch;
      pwnedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (!url.startsWith(PWNED_RANGE)) return realFetch(input, init);
        return Promise.resolve(
          new Response("", { status: 200, headers: { "content-type": "text/plain" } })
        );
      });
    });

    afterAll(() => {
      pwnedFetch.mockRestore();
    });

    const registeredPhone = async (name: string) => {
      const phone = await signInPhone(name);
      const token = apnsToken();
      expect((await register(phone, { token, environment: "sandbox" })).status).toBe(204);
      return { ...phone, token };
    };

    const expectNoRegistration = async (phone: { sessionId: string; token: string }) => {
      expect(await registrationOf(phone.sessionId)).toBeUndefined();
      expect(
        await db.select().from(pushRegistrations).where(eq(pushRegistrations.token, phone.token))
      ).toHaveLength(0);
    };

    const fromPhone = (phone: { device: string; cookie: string }, path: string) =>
      request(server.url).post(path).set(nativeHeaders(phone.device)).set("Cookie", phone.cookie);

    it("on sign-out", async () => {
      const phone = await registeredPhone("Push Sign Out Subject");

      expect((await fromPhone(phone, "/api/auth/sign-out").send({})).status).toBe(200);

      expect(await sessionsOf(phone.userId)).toHaveLength(0);
      await expectNoRegistration(phone);
    });

    it("when the same phone signs in again", async () => {
      const phone = await registeredPhone("Push Same Phone Subject");

      const again = await request(server.url)
        .post("/api/auth/sign-in/email")
        .set(nativeHeaders(phone.device))
        .send({ email: phone.email, password: WEB_TEST_PASSWORD });
      expect(again.status).toBe(200);

      await expectNoRegistration(phone);
    });

    it("when someone else signs in on the phone", async () => {
      const phone = await registeredPhone("Push Handed Over Subject");
      const next = await createWebUser("Push Next Owner Subject");

      const res = await request(server.url)
        .post("/api/auth/sign-in/email")
        .set(nativeHeaders(phone.device))
        .send({ email: next.email, password: WEB_TEST_PASSWORD });
      expect(res.status).toBe(200);

      await expectNoRegistration(phone);
    });

    it("when another device presents the phone's cookie", async () => {
      const phone = await registeredPhone("Push Device Mismatch Subject");

      const res = await request(server.url)
        .get("/api/auth/get-session")
        .set("Cookie", phone.cookie)
        .set("x-client-device-id", `device-${uuidv4()}`);
      expect(res.status).toBe(401);

      await expectNoRegistration(phone);
    });

    it("when the phone changes the password, though it stays signed in", async () => {
      const phone = await registeredPhone("Push Phone Password Subject");

      const res = await fromPhone(phone, "/api/auth/change-password").send({
        currentPassword: WEB_TEST_PASSWORD,
        newPassword: "another-sturdy-passphrase-73",
        revokeOtherSessions: true,
      });
      expect(res.status).toBe(200);

      expect(await sessionsOf(phone.userId)).toHaveLength(1);
      await expectNoRegistration(phone);
    });

    it("when the password is changed on the web", async () => {
      const phone = await registeredPhone("Push Web Password Subject");
      const web = await request(server.url)
        .post("/api/auth/sign-in/email")
        .set("Origin", BROWSER_ORIGIN)
        .send({ email: phone.email, password: WEB_TEST_PASSWORD });
      expect(web.status).toBe(200);

      const res = await request(server.url)
        .post("/api/auth/change-password")
        .set("Origin", BROWSER_ORIGIN)
        .set("Cookie", cookieHeaderOf(web))
        .send({
          currentPassword: WEB_TEST_PASSWORD,
          newPassword: "another-sturdy-passphrase-73",
          revokeOtherSessions: true,
        });
      expect(res.status).toBe(200);

      await expectNoRegistration(phone);
    });

    it("when the password is reset", async () => {
      const phone = await registeredPhone("Push Reset Subject");
      const token = `tok-${uuidv4()}`;
      await db.insert(verification).values({
        id: uuidv4(),
        identifier: `reset-password:${token}`,
        value: phone.userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await auth.api.resetPassword({ body: { newPassword: "Str0ng-Reset-Pass-9182", token } });

      await expectNoRegistration(phone);
    });

    it("when the phone turns two-factor on, though it stays signed in", async () => {
      const phone = await registeredPhone("Push Two Factor Subject");

      const enable = await fromPhone(phone, "/api/auth/two-factor/enable").send({
        password: WEB_TEST_PASSWORD,
      });
      expect(enable.status).toBe(200);
      const secret = new URL(enable.body.totpURI as string).searchParams.get("secret") ?? "";
      const { code } = await auth.api.generateTOTP({
        body: { secret: new TextDecoder().decode(base32.decode(secret)) },
      });

      const verified = await fromPhone(phone, "/api/auth/two-factor/verify-totp").send({ code });
      expect(verified.status).toBe(200);

      expect(await sessionsOf(phone.userId)).toHaveLength(1);
      await expectNoRegistration(phone);
    });

    it("when the account is deleted", async () => {
      const phone = await registeredPhone("Push Account Deletion Subject");

      const res = await fromPhone(phone, "/api/users/me/delete").send({
        password: WEB_TEST_PASSWORD,
      });
      expect(res.status).toBe(204);

      await expectNoRegistration(phone);
    });
  });
});
