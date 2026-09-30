import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { session as sessionTable } from "../../db/schema/auth-schema.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { WEB_TEST_PASSWORD, createWebUser } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import {
  cookieHeaderOf,
  lastCookie,
  nativeHeaders,
  sessionsOf,
  yearsUntil,
} from "./helpers/nativeSessionHelpers.js";

const DEV_TOKEN = "local-dev-token-0123456789";

// Mocked rather than enabled through the environment: `parseDevTools` refuses a
// database host that is not localhost, and the containerised suite reaches its
// Postgres as `postgres`.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      dev: { token: "local-dev-token-0123456789", seedEmailDomain: "dev.local" },
    },
  };
});

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const APP_SCHEME = "flexiday://";
const SESSION_COOKIE = "better-auth.session_token";
const REDEEM_PATH = "/api/auth/dev/redeem-sign-in-ticket";

/** Everything about a cookie except its value, in a comparable form. */
const cookieShape = (cookie: string | undefined): string[] =>
  (cookie ?? "")
    .split(";")
    .slice(1)
    .map((part) => part.trim().toLowerCase())
    .sort();

describe("dev sign-in ticket", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const deviceId = () => `device-${uuidv4()}`;

  const mint = (email: string, token: string | null = DEV_TOKEN) => {
    const req = request(server.url).post("/api/dev/sign-in-ticket");
    if (token !== null) req.set("x-dev-token", token);
    return req.send({ email });
  };

  const mintTicket = async (email: string): Promise<string> => {
    const res = await mint(email);
    expect(res.status).toBe(200);
    return res.body.ticket as string;
  };

  const redeem = (ticket: string, headers: Record<string, string>) =>
    request(server.url).post(REDEEM_PATH).set(headers).send({ ticket });

  describe("mint", () => {
    it("hands out a ticket that expires in sixty seconds", async () => {
      const { id, email } = await createWebUser("Ticket Mint Subject");
      const before = Date.now();

      const res = await mint(email);

      expect(res.status).toBe(200);
      expect(res.body.ticket).toEqual(expect.any(String));
      expect((res.body.ticket as string).length).toBeGreaterThanOrEqual(32);
      expect(res.body.user).toMatchObject({ id, email });
      const expiresAt = new Date(res.body.expiresAt as string).getTime();
      expect(expiresAt - before).toBeGreaterThanOrEqual(59_000);
      expect(expiresAt - before).toBeLessThanOrEqual(61_000);
      // Minting signs nobody in.
      expect(await sessionsOf(id)).toHaveLength(0);
    });

    it("refuses a caller without the dev token", async () => {
      const { email } = await createWebUser("Ticket Tokenless Subject");

      expect((await mint(email, null)).status).toBe(401);
      expect((await mint(email, "wrong-token-0123456789")).status).toBe(401);
    });

    it("answers 404 for an address with no account", async () => {
      const res = await mint(`nobody-${uuidv4()}@report-e2e.test`);
      expect(res.status).toBe(404);
    });
  });

  describe("redeem", () => {
    it("opens a device-bound session with the cookie a native password sign-in gets", async () => {
      const device = deviceId();
      const { id, email } = await createWebUser("Ticket Redeem Subject");

      const ticket = await mintTicket(email);
      const res = await redeem(ticket, nativeHeaders(device));

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id, email });
      const rows = await sessionsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deviceId: device });
      expect(yearsUntil(rows[0]!.expiresAt)).toBeGreaterThan(9.9);

      const signedIn = await request(server.url)
        .post("/api/auth/sign-in/email")
        .set(nativeHeaders(deviceId()))
        .send({ email, password: WEB_TEST_PASSWORD });
      expect(signedIn.status).toBe(200);

      const redeemed = lastCookie(res, SESSION_COOKIE);
      expect(redeemed).toBeDefined();
      expect(redeemed).not.toMatch(/max-age=|expires=/i);
      expect(cookieShape(redeemed)).toEqual(cookieShape(lastCookie(signedIn, SESSION_COOKIE)));

      const current = await request(server.url)
        .get("/api/auth/get-session")
        .set("Cookie", cookieHeaderOf(res))
        .set("x-client-device-id", device);
      expect(current.status).toBe(200);
      expect(current.body?.user?.id).toBe(id);
    });

    it("takes the place of the phone's earlier session", async () => {
      const device = deviceId();
      const first = await createWebUser("Ticket Earlier Session Subject");
      const second = await createWebUser("Ticket Later Session Subject");

      const earlier = await request(server.url)
        .post("/api/auth/sign-in/email")
        .set(nativeHeaders(device))
        .send({ email: first.email, password: WEB_TEST_PASSWORD });
      expect(earlier.status).toBe(200);
      expect(await sessionsOf(first.id)).toHaveLength(1);

      const res = await redeem(await mintTicket(second.email), nativeHeaders(device));

      expect(res.status).toBe(200);
      expect(await sessionsOf(first.id)).toHaveLength(0);
      const rows = await sessionsOf(second.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deviceId: device });
    });

    it("redeems a ticket once", async () => {
      const { id, email } = await createWebUser("Ticket Replay Subject");
      const ticket = await mintTicket(email);

      expect((await redeem(ticket, nativeHeaders(deviceId()))).status).toBe(200);
      const replay = await redeem(ticket, nativeHeaders(deviceId()));

      expect(replay.status).toBe(401);
      expect(await sessionsOf(id)).toHaveLength(1);
    });

    it("refuses a ticket past its sixty seconds, the way it refuses a spent one", async () => {
      const { id, email } = await createWebUser("Ticket Expiry Subject");

      const spent = await mintTicket(email);
      await redeem(spent, nativeHeaders(deviceId()));
      const replayed = await redeem(spent, nativeHeaders(deviceId()));
      await db.delete(sessionTable).where(eq(sessionTable.userId, id));

      const ticket = await mintTicket(email);
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
      const expired = await redeem(ticket, nativeHeaders(deviceId()));
      vi.useRealTimers();

      expect(expired.status).toBe(401);
      expect(expired.body).toEqual(replayed.body);
      expect(await sessionsOf(id)).toHaveLength(0);
    });

    it("refuses a ticket nobody minted with the same error", async () => {
      const { email } = await createWebUser("Ticket Unknown Subject");
      const spent = await mintTicket(email);
      await redeem(spent, nativeHeaders(deviceId()));
      const replayed = await redeem(spent, nativeHeaders(deviceId()));

      const res = await redeem(`forged-${uuidv4()}`, nativeHeaders(deviceId()));

      expect(res.status).toBe(401);
      expect(res.body).toEqual(replayed.body);
    });

    it("refuses a request without a usable device id and opens no session", async () => {
      const { id, email } = await createWebUser("Ticket Deviceless Subject");
      const ticket = await mintTicket(email);

      const missing = await redeem(ticket, { "expo-origin": APP_SCHEME });
      const malformed = await redeem(ticket, {
        "expo-origin": APP_SCHEME,
        "x-client-device-id": "no spaces allowed",
      });

      expect(missing.status).toBe(400);
      expect(malformed.status).toBe(400);
      expect(lastCookie(missing, SESSION_COOKIE)).toBeUndefined();
      expect(await sessionsOf(id)).toHaveLength(0);
    });
  });
});
