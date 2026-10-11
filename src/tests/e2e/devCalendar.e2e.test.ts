import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/db.js";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { cleanupTestData, createTestUser } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  calendarSync,
  calendarSyncScope,
  calendarSyncTypes,
} from "../../db/schema/calendar-sync-schema.js";
import { calendarConnection } from "../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType, vacation } from "../../db/schema/vacation-schema.js";
import {
  createSyncQueue,
  installCalendarSyncQueue,
  type SyncQueue,
} from "../../services/calendarSync/enqueueSync.js";
import { syncTarget } from "../../services/calendarSync/syncEngine.js";

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

const ROUTES = [
  { method: "post", path: "/api/dev/calendar/connect" },
  { method: "get", path: "/api/dev/calendar/events" },
  { method: "post", path: "/api/dev/calendar/capability" },
] as const;

type FakeEventRow = {
  connectionId: string;
  provider: string;
  operation: string;
  providerEventId: string | null;
  payload: Record<string, unknown> | null;
  result: string;
};

describe("dev calendar surface", () => {
  let server: LoopbackServer;
  let queue: SyncQueue;

  const dev = (method: "get" | "post", path: string) =>
    request(server.url)[method](path).set("x-dev-token", DEV_TOKEN);

  const connect = (body: Record<string, unknown>) =>
    dev("post", "/api/dev/calendar/connect").send(body);

  const dump = (email?: string) =>
    dev("get", "/api/dev/calendar/events").query(email ? { email } : {});

  const setCapability = (body: Record<string, unknown>) =>
    dev("post", "/api/dev/calendar/capability").send(body);

  const seedDevUser = async (local: string) => {
    const email = `${local}-${uuidv4().slice(0, 8)}@dev.local`;
    const created = await createTestUser(email, local, "pw");
    return { id: created.id, email };
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
    queue = createSyncQueue({ run: (id) => syncTarget(id), coalesceMs: 0 });
    installCalendarSyncQueue(queue);
  });

  afterAll(async () => {
    installCalendarSyncQueue(undefined);
    await server?.close();
    await cleanupTestData();
  });

  describe("gates", () => {
    it.each(ROUTES)("$method $path refuses a caller without the dev token", async (route) => {
      expect((await request(server.url)[route.method](route.path).send({})).status).toBe(401);
      expect(
        (
          await request(server.url)
            [route.method](route.path)
            .set("x-dev-token", "wrong-token-0123456789")
            .send({})
        ).status
      ).toBe(401);
    });

    describe("with dev tools off", () => {
      const saved = config.dev;
      let off: LoopbackServer;

      beforeAll(async () => {
        (config as { dev?: unknown }).dev = undefined;
        off = await listenOnLoopback(createServer());
      });

      afterAll(async () => {
        await off?.close();
        (config as { dev?: unknown }).dev = saved;
      });

      // Unmounted, the path falls through to the session-checked API, so a signed-in caller
      // holding the dev token still finds nothing there.
      it.each(ROUTES)("$method $path does not exist", async (route) => {
        const user = await createTestUser(`dev-off-${uuidv4()}@test.com`, "Off", "pw");
        const res = await request(off.url)
          [route.method](route.path)
          .set("x-dev-token", DEV_TOKEN)
          .set("Cookie", await authCookieFor(user.id))
          .send({});
        expect(res.status).toBe(404);
      });
    });
  });

  describe("POST /api/dev/calendar/connect", () => {
    afterEach(() => {
      config.calendarSync!.driver = "fake";
    });

    it("refuses to fabricate a connection unless the driver is fake", async () => {
      const user = await seedDevUser("live-driver");
      config.calendarSync!.driver = "live";

      const res = await connect({ email: user.email });

      expect(res.status).toBe(409);
      const rows = await db
        .select()
        .from(calendarConnection)
        .where(eq(calendarConnection.userId, user.id));
      expect(rows).toHaveLength(0);
    });

    it("refuses an address outside the seed domain", async () => {
      const res = await connect({ email: `someone-${uuidv4()}@test.com` });
      expect(res.status).toBe(400);
    });

    it("connects a seeded user to a new ME config with every record type and syncs it", async () => {
      const user = await seedDevUser("connect");

      const res = await connect({ email: user.email });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        provider: "GOOGLE",
        timeZone: "Europe/Prague",
        configCreated: true,
        entitled: false,
      });
      const [connection] = await db
        .select()
        .from(calendarConnection)
        .where(eq(calendarConnection.userId, user.id));
      expect(connection).toMatchObject({
        id: res.body.connectionId,
        provider: "GOOGLE",
        status: "ACTIVE",
        capability: "UNKNOWN",
        revokedAt: null,
      });
      const [config] = await db
        .select()
        .from(calendarSync)
        .where(eq(calendarSync.id, res.body.configId as string));
      expect(config).toMatchObject({
        userId: user.id,
        scope: calendarSyncScope.Me,
        connectionId: connection!.id,
        timeZone: "Europe/Prague",
      });
      const types = await db
        .select({ type: calendarSyncTypes.vacationType })
        .from(calendarSyncTypes)
        .where(eq(calendarSyncTypes.calendarSyncId, config!.id));
      expect(types.map((row) => row.type).sort()).toEqual(Object.values(CalendarRecordType).sort());

      await queue.drain();
      const [synced] = await db.select().from(calendarSync).where(eq(calendarSync.id, config!.id));
      // Not entitled: the sync pauses rather than writing, as it would for a real user.
      expect(synced).toMatchObject({ syncDueAt: null, lastError: "plan" });
    });

    it("reuses the config it attached before instead of creating another", async () => {
      const user = await seedDevUser("reconnect");
      const first = await connect({ email: user.email, provider: "microsoft" });
      const second = await connect({ email: user.email, provider: "microsoft" });

      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({
        provider: "MICROSOFT",
        configId: first.body.configId,
        connectionId: first.body.connectionId,
        configCreated: false,
      });
      const configs = await db
        .select()
        .from(calendarSync)
        .where(and(eq(calendarSync.userId, user.id), isNull(calendarSync.deletedAt)));
      expect(configs).toHaveLength(1);
    });

    it("attaches the config it is given, in the zone it is given", async () => {
      const user = await seedDevUser("given");
      const configId = uuidv4();
      await db.insert(calendarSync).values({
        id: configId,
        userId: user.id,
        name: "Mine",
        scope: calendarSyncScope.Me,
        token: `flx_live_${uuidv4().replaceAll("-", "")}`,
      });

      const res = await connect({ email: user.email, configId, timeZone: "America/New_York" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ configId, configCreated: false });
      const [row] = await db.select().from(calendarSync).where(eq(calendarSync.id, configId));
      expect(row).toMatchObject({ timeZone: "America/New_York", connectionId: expect.any(String) });
    });

    it("refuses a TEAM config", async () => {
      const user = await seedDevUser("team");
      const configId = uuidv4();
      await db.insert(calendarSync).values({
        id: configId,
        userId: user.id,
        name: "Team",
        scope: calendarSyncScope.Team,
        token: `flx_live_${uuidv4().replaceAll("-", "")}`,
      });

      const res = await connect({ email: user.email, configId });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].context).toMatchObject({ code: "CALENDAR_SYNC_TEAM_SCOPE" });
    });
  });

  describe("the dev scenario, then one approval", () => {
    let ownerId: string;
    let ownerEmail: string;

    beforeAll(async () => {
      const scenario = await dev("post", "/api/dev/scenario").send({});
      expect(scenario.status).toBe(201);
      ownerId = scenario.body.owner.id as string;
      ownerEmail = scenario.body.owner.email as string;
      expect(scenario.body.calendar).toMatchObject({ provider: "GOOGLE", entitled: true });
      await queue.drain();
    });

    it("connects the owner to a fake Google target", async () => {
      const [connection] = await db
        .select()
        .from(calendarConnection)
        .where(eq(calendarConnection.userId, ownerId));
      expect(connection).toMatchObject({ provider: "GOOGLE", status: "ACTIVE" });
    });

    it("leaves a row the dump returns", async () => {
      const [pending] = await db
        .select({ id: vacation.id })
        .from(vacation)
        .where(
          and(
            eq(vacation.userId, ownerId),
            isNull(vacation.approvedAt),
            isNull(vacation.rejectedAt),
            isNull(vacation.deletedAt)
          )
        );
      expect(pending).toBeDefined();

      await request(server.url)
        .post(`/api/vacation/approve/${pending!.id}`)
        .set("Cookie", await authCookieFor(ownerId))
        .expect(200);
      await queue.drain();

      const res = await dump(ownerEmail);
      expect(res.status).toBe(200);
      const inserted = (res.body.events as FakeEventRow[]).find(
        (event) =>
          event.operation === "INSERT" &&
          event.result === "ok" &&
          (event.payload?.extendedProperties as { private: Record<string, string> } | undefined)
            ?.private.flexiDayVacationId === pending!.id
      );
      expect(inserted).toMatchObject({ provider: "GOOGLE", payload: { summary: "Vacation" } });
      expect(res.body.ledger).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            vacationId: pending!.id,
            providerEventId: inserted!.providerEventId,
          }),
        ])
      );
    });

    it("lists the newest call first", async () => {
      const res = await dump(ownerEmail);
      const times = (res.body.events as { createdAt: string }[]).map((event) =>
        Date.parse(event.createdAt)
      );
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it("flips the capability to PLAIN, and the next sync rewrites the events as Busy ones", async () => {
      const res = await setCapability({ email: ownerEmail, capability: "PLAIN" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ provider: "GOOGLE", capability: "PLAIN" });
      expect(res.body.targetsMarked).toHaveLength(1);
      await queue.drain();

      const events = (await dump(ownerEmail)).body.events as FakeEventRow[];
      const latestInsert = events.find((event) => event.operation === "INSERT");
      expect(latestInsert?.payload).toMatchObject({ eventType: "default" });
      const [connection] = await db
        .select()
        .from(calendarConnection)
        .where(eq(calendarConnection.userId, ownerId));
      expect(connection!.capability).toBe("PLAIN");
    });

    it("flips it back to UNKNOWN", async () => {
      const res = await setCapability({
        email: ownerEmail,
        provider: "google",
        capability: "UNKNOWN",
      });

      expect(res.status).toBe(200);
      expect(res.body.capability).toBe("UNKNOWN");
    });
  });

  describe("GET /api/dev/calendar/events", () => {
    it("answers 404 for an address with no account", async () => {
      expect((await dump(`nobody-${uuidv4()}@dev.local`)).status).toBe(404);
    });

    it("dumps every user's calls without an address", async () => {
      const res = await dump();
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(Array.isArray(res.body.ledger)).toBe(true);
    });
  });

  describe("POST /api/dev/calendar/capability", () => {
    it("answers 404 for a user with no connection", async () => {
      const user = await seedDevUser("unconnected");
      expect((await setCapability({ email: user.email, capability: "PLAIN" })).status).toBe(404);
    });

    it("asks for the provider when the user has two connections", async () => {
      const user = await seedDevUser("both");
      await connect({ email: user.email, provider: "google" });
      await connect({ email: user.email, provider: "microsoft" });

      expect((await setCapability({ email: user.email, capability: "PLAIN" })).status).toBe(400);
      expect(
        (await setCapability({ email: user.email, provider: "microsoft", capability: "PLAIN" }))
          .status
      ).toBe(200);
    });

    it("rejects an unknown capability", async () => {
      const user = await seedDevUser("bad-capability");
      expect((await setCapability({ email: user.email, capability: "SOMETIMES" })).status).toBe(
        422
      );
    });
  });
});
