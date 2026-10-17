import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/db.js";
import { createServer } from "../../server.js";
import { config } from "../../config.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { cleanupTestData, createTestGroup, createTestUser } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { account } from "../../db/schema/auth-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { calendarSync, calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import {
  calendarCapability,
  calendarConnection,
  calendarConnectionStatus,
  calendarProvider,
  calendarSyncEventKind,
  calendarSyncEvents,
} from "../../db/schema/calendar-connection-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { connectionAccessToken } from "../../services/calendarConnection/calendarConnectionServices.js";
import { ProviderGrantRevokedError } from "../../services/calendarConnection/providers/types.js";
import { FAKE_REVOKED_MARKER } from "../../services/calendarConnection/providers/fake.js";

const insertConfig = async (userId: string, scope: calendarSyncScope, name: string) => {
  const id = uuidv4();
  await db.insert(calendarSync).values({
    id,
    userId,
    name,
    scope,
    token: `flx_live_${uuidv4().replaceAll("-", "")}`,
  });
  return id;
};

const joinGroup = (userId: string, groupId: string) =>
  db.insert(groupUsers).values({ id: uuidv4(), userId, groupId, viewAccess: true });

const configRow = async (id: string) =>
  (await db.select().from(calendarSync).where(eq(calendarSync.id, id)))[0]!;

const liveConnection = async (userId: string, provider: calendarProvider) =>
  (
    await db
      .select()
      .from(calendarConnection)
      .where(and(eq(calendarConnection.userId, userId), eq(calendarConnection.provider, provider)))
  )[0];

describe("calendar direct sync routes on the fake driver", () => {
  let server: LoopbackServer;
  let owner: { id: string };
  let freeUser: { id: string };
  let ownerCookie: string;
  let freeCookie: string;
  let meConfigId: string;
  let secondMeConfigId: string;
  let teamConfigId: string;
  let freeConfigId: string;
  let paidGroupId: string;

  const appUrl = () => config.calendarSync!.appUrl;

  /** Starts a consent round and follows the fake consent URL back to our callback. */
  const connect = async (provider: "google" | "microsoft", configId: string, code?: string) => {
    const start = await request(server.url)
      .post(`/api/calendar-sync/connections/${provider}/start`)
      .set("Cookie", ownerCookie)
      .send({ configId, timeZone: "Europe/Prague" });
    expect(start.status).toBe(200);
    const consent = new URL(start.body.url);
    if (code) consent.searchParams.set("code", code);
    return request(server.url).get(`${consent.pathname}${consent.search}`);
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    owner = await createTestUser("direct-sync-owner@test.com", "Direct Sync Owner", "pw");
    freeUser = await createTestUser("direct-sync-free@test.com", "Direct Sync Free", "pw");

    const paidGroup = await createTestGroup("Paid team", owner.id);
    await joinGroup(owner.id, paidGroup.id);
    paidGroupId = paidGroup.id;
    const organization = await ensureOrganizationForUser(owner.id);
    await upsertSubscription(organization.id, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
    });

    const freeGroup = await createTestGroup("Free team", freeUser.id);
    await joinGroup(freeUser.id, freeGroup.id);

    await db.insert(account).values({
      id: uuidv4(),
      userId: owner.id,
      providerId: "google",
      accountId: "google-sign-in-subject",
      refreshToken: "sign-in-refresh-token",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    meConfigId = await insertConfig(owner.id, calendarSyncScope.Me, "Mine");
    secondMeConfigId = await insertConfig(owner.id, calendarSyncScope.Me, "Mine on Outlook");
    teamConfigId = await insertConfig(owner.id, calendarSyncScope.Team, "Team");
    freeConfigId = await insertConfig(freeUser.id, calendarSyncScope.Me, "Free");

    ownerCookie = await authCookieFor(owner.id);
    freeCookie = await authCookieFor(freeUser.id);
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  it("lists no connections and both providers switched on", async () => {
    const res = await request(server.url)
      .get("/api/calendar-sync/connections")
      .set("Cookie", ownerCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: { google: true, microsoft: true }, connections: [] });
  });

  it("refuses to start on a TEAM config with a code the web maps", async () => {
    const res = await request(server.url)
      .post("/api/calendar-sync/connections/google/start")
      .set("Cookie", ownerCookie)
      .send({ configId: teamConfigId, timeZone: "Europe/Prague" });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].context).toEqual({ code: "CALENDAR_SYNC_TEAM_SCOPE" });
  });

  it("refuses to start for a user no paid organization covers", async () => {
    const res = await request(server.url)
      .post("/api/calendar-sync/connections/google/start")
      .set("Cookie", freeCookie)
      .send({ configId: freeConfigId, timeZone: "Europe/Prague" });

    expect(res.status).toBe(402);
    expect(res.body.errors[0].context).toEqual({
      reason: "PLAN_LIMIT",
      code: "CALENDAR_SYNC_PLAN_REQUIRED",
    });
  });

  it("answers 404 for an unknown provider and 422 for an offset time zone", async () => {
    const unknown = await request(server.url)
      .post("/api/calendar-sync/connections/apple/start")
      .set("Cookie", ownerCookie)
      .send({ configId: meConfigId, timeZone: "Europe/Prague" });
    const offset = await request(server.url)
      .post("/api/calendar-sync/connections/google/start")
      .set("Cookie", ownerCookie)
      .send({ configId: meConfigId, timeZone: "+01:00" });

    expect(unknown.status).toBe(404);
    expect(unknown.body.errors[0].context).toEqual({ code: "CALENDAR_SYNC_PROVIDER_OFF" });
    expect(offset.status).toBe(422);
  });

  it("needs a session to start", async () => {
    const res = await request(server.url)
      .post("/api/calendar-sync/connections/google/start")
      .send({ configId: meConfigId, timeZone: "Europe/Prague" });

    expect(res.status).toBe(401);
  });

  it("connects Google through the callback without a session and attaches the config", async () => {
    const res = await connect("google", meConfigId);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${appUrl()}/calendar-sync/?connected=google&config=${meConfigId}`
    );

    const connection = await liveConnection(owner.id, calendarProvider.Google);
    expect(connection).toMatchObject({
      status: calendarConnectionStatus.Active,
      capability: calendarCapability.Unknown,
    });
    expect(connection!.refreshTokenEnc).not.toContain("fake-refresh");

    const config = await configRow(meConfigId);
    expect(config.connectionId).toBe(connection!.id);
    expect(config.timeZone).toBe("Europe/Prague");
    expect(config.syncDueAt).toBeInstanceOf(Date);
  });

  it("shows the target on the calendar list and detail", async () => {
    const list = await request(server.url).get("/api/calendar-sync").set("Cookie", ownerCookie);
    const detail = await request(server.url)
      .get(`/api/calendar-sync/${meConfigId}`)
      .set("Cookie", ownerCookie);

    const expected = {
      provider: "GOOGLE",
      status: "ACTIVE",
      capability: "UNKNOWN",
      timeZone: "Europe/Prague",
      lastSyncedAt: null,
      lastError: null,
      syncing: true,
    };
    expect(detail.body.target).toEqual(expected);
    const byId = new Map(list.body.map((c: { id: string }) => [c.id, c]));
    expect((byId.get(meConfigId) as { target: unknown }).target).toEqual(expected);
    expect((byId.get(teamConfigId) as { target: unknown }).target).toBeNull();
  });

  it("lists the connection without any token", async () => {
    const res = await request(server.url)
      .get("/api/calendar-sync/connections")
      .set("Cookie", ownerCookie);

    expect(res.body.connections).toEqual([
      {
        provider: "GOOGLE",
        status: "ACTIVE",
        capability: "UNKNOWN",
        createdAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it("refuses to point a connected config at the other provider", async () => {
    const res = await request(server.url)
      .post("/api/calendar-sync/connections/microsoft/start")
      .set("Cookie", ownerCookie)
      .send({ configId: meConfigId, timeZone: "Europe/Prague" });

    expect(res.status).toBe(409);
    expect(res.body.errors[0].context).toEqual({ code: "CALENDAR_SYNC_TARGET_EXISTS" });
  });

  it("rejects a tampered state with a redirect and writes nothing", async () => {
    const before = await db.select().from(calendarConnection);
    const start = await request(server.url)
      .post("/api/calendar-sync/connections/google/start")
      .set("Cookie", ownerCookie)
      .send({ configId: secondMeConfigId, timeZone: "Europe/Prague" });
    const consent = new URL(start.body.url);
    const state = consent.searchParams.get("state")!;
    const payload = JSON.parse(Buffer.from(state.split(".")[0]!, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, userId: freeUser.id })).toString(
      "base64url"
    );
    consent.searchParams.set("state", `${forged}.${state.split(".")[1]}`);

    const res = await request(server.url).get(`${consent.pathname}${consent.search}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${appUrl()}/calendar-sync/?error=state_invalid&provider=google`
    );
    expect(await db.select().from(calendarConnection)).toEqual(before);
    expect((await configRow(secondMeConfigId)).connectionId).toBeNull();
  });

  it.each(["google", "microsoft"])(
    "reports a declined %s consent back to the web with the provider",
    async (provider) => {
      const start = await request(server.url)
        .post(`/api/calendar-sync/connections/${provider}/start`)
        .set("Cookie", ownerCookie)
        .send({ configId: secondMeConfigId, timeZone: "Europe/Prague" });
      const consent = new URL(start.body.url);
      consent.searchParams.delete("code");
      consent.searchParams.set("error", "access_denied");

      const res = await request(server.url).get(`${consent.pathname}${consent.search}`);

      expect(res.headers.location).toBe(
        `${appUrl()}/calendar-sync/?error=consent_denied&provider=${provider}&config=${secondMeConfigId}`
      );
    }
  );

  it("edits the target's time zone and marks it due", async () => {
    await db.update(calendarSync).set({ syncDueAt: null }).where(eq(calendarSync.id, meConfigId));

    const res = await request(server.url)
      .put(`/api/calendar-sync/${meConfigId}/target`)
      .set("Cookie", ownerCookie)
      .send({ timeZone: "America/New_York" });

    expect(res.status).toBe(200);
    expect(res.body.target).toMatchObject({ timeZone: "America/New_York", syncing: true });
  });

  it("queues a sync now", async () => {
    await db.update(calendarSync).set({ syncDueAt: null }).where(eq(calendarSync.id, meConfigId));

    const res = await request(server.url)
      .post(`/api/calendar-sync/${meConfigId}/target/sync`)
      .set("Cookie", ownerCookie);

    expect(res.status).toBe(202);
    expect(res.body.target.syncing).toBe(true);
    expect((await configRow(meConfigId)).syncDueAt).toBeInstanceOf(Date);
  });

  it("refuses to switch a connected config to TEAM with a mapped 400", async () => {
    const res = await request(server.url)
      .put(`/api/calendar-sync/${meConfigId}`)
      .set("Cookie", ownerCookie)
      .send({
        name: "Mine",
        scope: "TEAM",
        teamIds: [paidGroupId],
        types: [{ type: "VACATION", color: "violet" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].context).toEqual({ code: "CALENDAR_SYNC_TEAM_SCOPE" });
    expect((await configRow(meConfigId)).scope).toBe(calendarSyncScope.Me);
  });

  it("connects Microsoft for a second config", async () => {
    const res = await connect("microsoft", secondMeConfigId);

    expect(res.headers.location).toBe(
      `${appUrl()}/calendar-sync/?connected=microsoft&config=${secondMeConfigId}`
    );
    expect((await configRow(secondMeConfigId)).connectionId).toBe(
      (await liveConnection(owner.id, calendarProvider.Microsoft))!.id
    );
  });

  it("flips a revoked grant to needs-reconnect, refuses Sync now, and revives on reconnect", async () => {
    await connect("microsoft", secondMeConfigId, FAKE_REVOKED_MARKER);
    const revoked = await liveConnection(owner.id, calendarProvider.Microsoft);
    await db
      .update(calendarConnection)
      .set({ accessTokenExpiresAt: new Date(0), capability: calendarCapability.Plain })
      .where(eq(calendarConnection.id, revoked!.id));

    await expect(
      connectionAccessToken((await liveConnection(owner.id, calendarProvider.Microsoft))!)
    ).rejects.toBeInstanceOf(ProviderGrantRevokedError);

    expect((await liveConnection(owner.id, calendarProvider.Microsoft))!.status).toBe(
      calendarConnectionStatus.NeedsReconnect
    );
    const stopped = await configRow(secondMeConfigId);
    expect(stopped.syncDueAt).toBeNull();
    expect(stopped.lastError).toBe("auth_revoked");

    const syncNow = await request(server.url)
      .post(`/api/calendar-sync/${secondMeConfigId}/target/sync`)
      .set("Cookie", ownerCookie);
    expect(syncNow.status).toBe(409);
    expect(syncNow.body.errors[0].context).toEqual({ code: "CALENDAR_SYNC_NEEDS_RECONNECT" });

    await connect("microsoft", secondMeConfigId);
    const revived = await liveConnection(owner.id, calendarProvider.Microsoft);
    expect(revived).toMatchObject({
      id: revoked!.id,
      status: calendarConnectionStatus.Active,
      capability: calendarCapability.Unknown,
    });
    expect((await configRow(secondMeConfigId)).syncDueAt).toBeInstanceOf(Date);
  });

  it("turns one target off, removing only its ledger, and keeps the connection", async () => {
    const otherTargetEvent = uuidv4();
    await db.insert(calendarSyncEvents).values([
      {
        id: uuidv4(),
        calendarSyncId: secondMeConfigId,
        kind: calendarSyncEventKind.Absence,
        contentHash: "hash",
      },
      {
        id: otherTargetEvent,
        calendarSyncId: meConfigId,
        kind: calendarSyncEventKind.Absence,
        contentHash: "hash",
      },
    ]);

    const res = await request(server.url)
      .delete(`/api/calendar-sync/${secondMeConfigId}/target`)
      .set("Cookie", ownerCookie);
    const again = await request(server.url)
      .delete(`/api/calendar-sync/${secondMeConfigId}/target`)
      .set("Cookie", ownerCookie);

    expect(res.status).toBe(200);
    expect(again.status).toBe(404);
    const config = await configRow(secondMeConfigId);
    expect(config).toMatchObject({ connectionId: null, timeZone: null, syncDueAt: null });
    expect(
      await db
        .select()
        .from(calendarSyncEvents)
        .where(eq(calendarSyncEvents.calendarSyncId, secondMeConfigId))
    ).toEqual([]);
    expect(
      await db.select().from(calendarSyncEvents).where(eq(calendarSyncEvents.id, otherTargetEvent))
    ).toHaveLength(1);
    expect(await liveConnection(owner.id, calendarProvider.Microsoft)).toBeDefined();
  });

  it("disconnects Google, purging its targets and leaving the sign-in account untouched", async () => {
    const accountsBefore = await db.select().from(account).where(eq(account.userId, owner.id));

    const res = await request(server.url)
      .delete("/api/calendar-sync/connections/google")
      .set("Cookie", ownerCookie);
    const again = await request(server.url)
      .delete("/api/calendar-sync/connections/google")
      .set("Cookie", ownerCookie);

    expect(res.status).toBe(200);
    expect(again.status).toBe(404);
    expect(await liveConnection(owner.id, calendarProvider.Google)).toBeUndefined();
    expect((await configRow(meConfigId)).connectionId).toBeNull();
    expect(
      await db
        .select()
        .from(calendarSyncEvents)
        .where(eq(calendarSyncEvents.calendarSyncId, meConfigId))
    ).toEqual([]);
    expect(await db.select().from(account).where(eq(account.userId, owner.id))).toEqual(
      accountsBefore
    );
    expect(accountsBefore).toHaveLength(1);
  });
});
