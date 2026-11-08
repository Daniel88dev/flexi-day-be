import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { assistantModelCalls } from "../../db/schema/assistant-meter-schema.js";
import { assistantRejectedTurns } from "../../db/schema/assistant-schema.js";
import {
  aiConnectionDailyCalls,
  aiConnectionMemberDailyCalls,
} from "../../db/schema/ai-connection-usage-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { readWeeklyUsage } from "../../services/assistant/meter/meter.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createWebUser } from "./helpers/authHelper.js";
import { apiAs } from "./helpers/directoryWorld.js";
import { addMember, makeGroup, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { connectAiApp, routePublicUrlTo } from "./helpers/aiConnectionGrant.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ON = { assistantEnabled: true, aiConnectionsEnabled: true, previewOrganizationIds: [] };
const TEN_DOLLARS = 10_000_000;
const DAY_MS = 86_400_000;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const utcToday = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};
const daysAgo = (days: number) => isoDay(new Date(utcToday().getTime() - days * DAY_MS));
/** Monday of the UTC week `weeks` weeks back. */
const weekStart = (weeks: number) => {
  const today = utcToday();
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  return isoDay(new Date(today.getTime() - (sinceMonday + weeks * 7) * DAY_MS));
};

/**
 * Acme (Enterprise, Assistant on, AI connections Read and write): Olga owns it,
 * Ada is an org admin, Jana and Ben are members. Beta: Bob owns it.
 */
const seed = async () => {
  const olga = await createWebUser("Olga Owner");
  const ada = await createWebUser("Ada Admin");
  const jana = await createWebUser("Jana Member");
  const ben = await createWebUser("Ben Member");
  const bob = await createWebUser("Bob Beta");
  const world = async (owner: { id: string }, people: { id: string }[]) => {
    const group = await makeGroup("Team", owner.id, { organizationOwnerId: owner.id });
    const [organization] = await db
      .update(organizations)
      .set({ assistantEnabled: true, aiConnections: aiConnectionsLevel.Write })
      .where(eq(organizations.ownerUserId, owner.id))
      .returning({ id: organizations.id });
    await upsertSubscription(organization!.id, {
      plan: subscriptionPlan.Enterprise,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    for (const person of people) await addMember(group, person.id);
    for (const person of [owner, ...people]) await syncEmployment(organization!.id, person.id);
    return organization!.id;
  };
  const acmeId = await world(olga, [ada, jana, ben]);
  await db.insert(organizationUsers).values({
    id: generateRandomUUID(),
    organizationId: acmeId,
    userId: ada.id,
    grantedByUserId: olga.id,
  });
  const betaId = await world(bob, []);
  return { acmeId, betaId, olga, ada, jana, ben, bob };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

type Person = {
  userId: string | null;
  name: string | null;
  assistantMicroUsd: number;
  refusedTurns: number;
  callsToday: number;
  apps: { grantId: string; app: { name: string | null }; access: string }[];
};

type Usage = {
  organizationId: string;
  organizationName: string;
  assistant: {
    on: boolean;
    weekStart: string;
    usedMicroUsd: number;
    limitMicroUsd: number;
    resetsAt: string;
    reached: boolean;
    limitReachedAt: string | null;
    weeks: {
      weekStart: string;
      usedMicroUsd: number;
      limitReachedAt: string | null;
      perPerson: boolean;
    }[];
  };
  aiConnections: {
    on: boolean;
    dailyLimit: number;
    memberDailyLimit: number;
    callsToday: number;
    resetsAt: string;
    days: { day: string; calls: number; limitReachedAt: string | null }[];
  };
  people: Person[];
};

describe("The AI usage page's endpoints", () => {
  let server: LoopbackServer;
  let restoreFetch: () => void;
  let s: Seeded;
  const savedSwitches = config.aiFeatures;
  const savedLimit = config.assistant.weeklyLimitMicroUsd;

  const resetData = async () => {
    await cleanupTestData();
    await resetReportData();
  };

  const spend = async (
    microUsd: number,
    options: {
      userId?: string | null;
      status?: "settled" | "reserved";
      weekStart?: string;
      createdAt?: Date;
    } = {}
  ) => {
    const status = options.status ?? "settled";
    await db.insert(assistantModelCalls).values({
      id: generateRandomUUID(),
      organizationId: s.acmeId,
      userId: options.userId === undefined ? s.jana.id : options.userId,
      purpose: "main",
      modelId: "claude-sonnet-5-5",
      priceVersion: "claude-sonnet-5-5@2026-11-01",
      status,
      reservedMicroUsd: microUsd,
      settledMicroUsd: status === "settled" ? microUsd : null,
      ...(options.weekStart ? { weekStart: options.weekStart } : {}),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    });
  };

  const usageAs = async (userId: string, organizationId = s.acmeId) =>
    (await apiAs(server.url, userId)).get(
      `/api/organization/ai/usage?organizationId=${organizationId}`
    );

  const usage = async (userId = s.olga.id) => {
    const res = await usageAs(userId);
    expect(res.status).toBe(200);
    return res.body as Usage;
  };

  const personOf = (body: Usage, userId: string | null) =>
    body.people.find((person) => person.userId === userId);

  const mcpInitialize = (token: string) =>
    fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "1" },
        },
      }),
    });

  beforeAll(async () => {
    config.aiFeatures = { ...ON };
    config.assistant.weeklyLimitMicroUsd = TEN_DOLLARS;
    server = await listenOnLoopback(createServer());
    restoreFetch = routePublicUrlTo(server.url);
    await resetData();
    s = await seed();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    config.assistant.weeklyLimitMicroUsd = savedLimit;
    restoreFetch();
    await server?.close();
    await db.delete(assistantModelCalls);
    await db.delete(aiConnectionDailyCalls);
    await db.delete(aiConnectionMemberDailyCalls);
    await resetData();
  });

  describe("access", () => {
    it("answers the owner and an org admin", async () => {
      for (const userId of [s.olga.id, s.ada.id]) {
        const res = await usageAs(userId);
        expect(res.status).toBe(200);
        expect((res.body as Usage).organizationId).toBe(s.acmeId);
        const week = await (
          await apiAs(server.url, userId)
        ).get(`/api/organization/ai/usage/weeks/${weekStart(1)}?organizationId=${s.acmeId}`);
        expect(week.status).toBe(200);
      }
    });

    it("refuses a member and another organization's owner", async () => {
      for (const userId of [s.jana.id, s.bob.id]) {
        expect((await usageAs(userId)).status).toBe(403);
        const api = await apiAs(server.url, userId);
        expect(
          (
            await api.get(
              `/api/organization/ai/usage/weeks/${weekStart(1)}?organizationId=${s.acmeId}`
            )
          ).status
        ).toBe(403);
        expect(
          (
            await api.delete(
              `/api/organization/ai/connections/any-grant?organizationId=${s.acmeId}`
            )
          ).status
        ).toBe(403);
      }
    });

    it("refuses to revoke a member's own grant for a member, and another organization's grant", async () => {
      const { clientId } = await connectAiApp({
        serverUrl: server.url,
        email: s.jana.email,
        organizationId: s.acmeId,
      });
      const body = await usage();
      const grant = personOf(body, s.jana.id)!.apps.find((app) => app.app.name)!;
      expect(grant).toBeDefined();

      const asJana = await apiAs(server.url, s.jana.id);
      expect(
        (
          await asJana.delete(
            `/api/organization/ai/connections/${grant.grantId}?organizationId=${s.acmeId}`
          )
        ).status
      ).toBe(403);
      const asBob = await apiAs(server.url, s.bob.id);
      expect(
        (
          await asBob.delete(
            `/api/organization/ai/connections/${grant.grantId}?organizationId=${s.betaId}`
          )
        ).status
      ).toBe(404);
      expect(personOf(await usage(), s.jana.id)!.apps.map((app) => app.grantId)).toContain(
        grant.grantId
      );
      expect(clientId).toBeTruthy();
    });
  });

  describe("kill switches", () => {
    const OFF = {
      assistantEnabled: false,
      aiConnectionsEnabled: false,
      previewOrganizationIds: [],
    };
    let grantId: string;

    beforeEach(async () => {
      config.aiFeatures = { ...ON };
      await connectAiApp({ serverUrl: server.url, email: s.ada.email, organizationId: s.acmeId });
      grantId = personOf(await usage(), s.ada.id)!.apps[0]!.grantId;
    });

    afterEach(async () => {
      config.aiFeatures = { ...ON };
      await (
        await apiAs(server.url, s.olga.id)
      ).delete(`/api/organization/ai/connections/${grantId}?organizationId=${s.acmeId}`);
    });

    const statuses = async () => {
      const api = await apiAs(server.url, s.olga.id);
      const query = `?organizationId=${s.acmeId}`;
      return {
        usage: (await usageAs(s.olga.id)).status,
        week: (await api.get(`/api/organization/ai/usage/weeks/${weekStart(1)}${query}`)).status,
        revoke: (await api.delete(`/api/organization/ai/connections/${grantId}${query}`)).status,
      };
    };

    it("answers 404 on the usage page and the revoke while both features are off", async () => {
      config.aiFeatures = { ...OFF };
      expect(await statuses()).toEqual({ usage: 404, week: 404, revoke: 404 });
      config.aiFeatures = { ...ON };
      expect(personOf(await usage(), s.ada.id)!.apps.map((app) => app.grantId)).toEqual([grantId]);
    });

    it("keeps the usage page while either feature is on, and the revoke only with AI connections", async () => {
      config.aiFeatures = { ...OFF, assistantEnabled: true };
      expect(await statuses()).toEqual({ usage: 200, week: 200, revoke: 404 });
      config.aiFeatures = { ...OFF, aiConnectionsEnabled: true };
      expect(await statuses()).toEqual({ usage: 200, week: 200, revoke: 204 });
    });

    it("opens both to an organization on the preview list, and only to it", async () => {
      config.aiFeatures = { ...OFF, previewOrganizationIds: [s.betaId] };
      expect(await statuses()).toEqual({ usage: 404, week: 404, revoke: 404 });
      config.aiFeatures = { ...OFF, previewOrganizationIds: [s.acmeId] };
      expect(await statuses()).toEqual({ usage: 200, week: 200, revoke: 204 });
    });
  });

  describe("Assistant this week", () => {
    it("matches the meter's settled plus reserved figure", async () => {
      await db.delete(assistantModelCalls);
      await spend(2_180_000);
      await spend(500_000, { status: "reserved" });
      await spend(1_640_000, { userId: s.ben.id });
      await spend(9_000_000, { weekStart: weekStart(1) });

      const body = await usage();
      const meter = (await readWeeklyUsage([s.acmeId])).get(s.acmeId)!;

      expect(body.assistant.usedMicroUsd).toBe(4_320_000);
      expect(body.assistant.usedMicroUsd).toBe(meter.usedMicroUsd);
      expect(body.assistant.limitMicroUsd).toBe(TEN_DOLLARS);
      expect(body.assistant.resetsAt).toBe(meter.resetsAt.toISOString());
      expect(body.assistant.reached).toBe(false);
      expect(body.assistant.limitReachedAt).toBeNull();
      expect(body.assistant.weekStart).toBe(weekStart(0));
      expect(body.assistant.on).toBe(true);
      expect(personOf(body, s.jana.id)!.assistantMicroUsd).toBe(2_680_000);
      expect(personOf(body, s.ben.id)!.assistantMicroUsd).toBe(1_640_000);
    });

    it("marks the week the limit was reached and when", async () => {
      await db.delete(assistantModelCalls);
      const monday = new Date(`${weekStart(0)}T00:00:00Z`);
      await spend(6_000_000, { createdAt: new Date(monday.getTime() + 60_000) });
      await spend(3_999_000, { createdAt: new Date(monday.getTime() + 120_000) });
      await spend(1_000, { userId: s.ben.id, createdAt: new Date(monday.getTime() + 180_000) });

      const body = await usage();

      expect(body.assistant.reached).toBe(true);
      expect(body.assistant.limitReachedAt).toBe(
        new Date(monday.getTime() + 120_000).toISOString()
      );
    });
  });

  describe("Past weeks", () => {
    it("lists past weeks newest first, marks limit-reached ones, and splits by person within 180 days", async () => {
      await db.delete(assistantModelCalls);
      await db.delete(assistantRejectedTurns);
      const lastWeek = weekStart(1);
      await spend(4_000_000, { weekStart: lastWeek });
      await spend(2_000_000, { weekStart: lastWeek, userId: s.ben.id });
      await spend(TEN_DOLLARS, { weekStart: weekStart(3) });
      await spend(7_000_000, { weekStart: weekStart(30) });
      await spend(1_000_000, { weekStart: lastWeek, userId: null });
      await db.insert(assistantRejectedTurns).values({
        id: generateRandomUUID(),
        organizationId: s.acmeId,
        userId: s.ben.id,
        reason: "off_topic",
        createdAt: new Date(`${lastWeek}T10:00:00Z`),
      });

      const body = await usage();

      expect(
        body.assistant.weeks.map((week) => [week.weekStart, week.usedMicroUsd, week.perPerson])
      ).toEqual([
        [lastWeek, 7_000_000, true],
        [weekStart(3), TEN_DOLLARS, true],
        [weekStart(30), 7_000_000, false],
      ]);
      expect(body.assistant.weeks[0]!.limitReachedAt).toBeNull();
      expect(body.assistant.weeks[1]!.limitReachedAt).not.toBeNull();

      const api = await apiAs(server.url, s.ada.id);
      const week = await api.get(
        `/api/organization/ai/usage/weeks/${lastWeek}?organizationId=${s.acmeId}`
      );
      expect(week.status).toBe(200);
      expect(week.body).toEqual({
        weekStart: lastWeek,
        usedMicroUsd: 7_000_000,
        people: [
          {
            userId: s.jana.id,
            name: "Jana Member",
            assistantMicroUsd: 4_000_000,
            refusedTurns: 0,
          },
          { userId: s.ben.id, name: "Ben Member", assistantMicroUsd: 2_000_000, refusedTurns: 1 },
          { userId: null, name: null, assistantMicroUsd: 1_000_000, refusedTurns: 0 },
        ],
      });

      const old = await api.get(
        `/api/organization/ai/usage/weeks/${weekStart(30)}?organizationId=${s.acmeId}`
      );
      expect(old.body).toEqual({ weekStart: weekStart(30), usedMicroUsd: 7_000_000, people: null });

      expect(
        (await api.get(`/api/organization/ai/usage/weeks/not-a-day?organizationId=${s.acmeId}`))
          .status
      ).toBe(422);
    });
  });

  describe("People", () => {
    it("shows refused turns, calls today and an erased account as Deleted account", async () => {
      await db.delete(assistantModelCalls);
      await db.delete(assistantRejectedTurns);
      await spend(390_000, { userId: null });
      await db.insert(assistantRejectedTurns).values(
        [1, 2, 3, 4].map(() => ({
          id: generateRandomUUID(),
          organizationId: s.acmeId,
          userId: s.ben.id,
          reason: "attack" as const,
        }))
      );
      await db.insert(aiConnectionMemberDailyCalls).values({
        organizationId: s.acmeId,
        userId: s.ben.id,
        calls: 1000,
      });

      const body = await usage();

      expect(personOf(body, null)).toEqual({
        userId: null,
        name: null,
        assistantMicroUsd: 390_000,
        refusedTurns: 0,
        callsToday: 0,
        apps: [],
      });
      expect(personOf(body, s.ben.id)).toMatchObject({
        name: "Ben Member",
        refusedTurns: 4,
        callsToday: 1000,
      });
      expect(personOf(body, s.olga.id)).toBeUndefined();
      await db.delete(aiConnectionMemberDailyCalls);
    });
  });

  describe("AI connections today", () => {
    it("counts today's calls against the daily limit and serves 14 days, oldest first", async () => {
      await db.insert(aiConnectionDailyCalls).values([
        { organizationId: s.acmeId, calls: 2364 },
        {
          organizationId: s.acmeId,
          day: daysAgo(3),
          calls: 20000,
          limitReachedAt: new Date(`${daysAgo(3)}T15:06:00Z`),
        },
        { organizationId: s.acmeId, day: daysAgo(20), calls: 5 },
        { organizationId: s.betaId, calls: 7 },
      ]);

      const body = await usage();

      expect(body.aiConnections).toMatchObject({
        on: true,
        dailyLimit: 20000,
        memberDailyLimit: 1000,
        callsToday: 2364,
      });
      expect(body.aiConnections.resetsAt).toBe(
        new Date(utcToday().getTime() + DAY_MS).toISOString()
      );
      expect(body.aiConnections.days).toHaveLength(14);
      expect(body.aiConnections.days[0]!.day).toBe(daysAgo(13));
      expect(body.aiConnections.days[13]).toEqual({
        day: daysAgo(0),
        calls: 2364,
        limitReachedAt: null,
      });
      expect(body.aiConnections.days[10]).toEqual({
        day: daysAgo(3),
        calls: 20000,
        limitReachedAt: new Date(`${daysAgo(3)}T15:06:00Z`).toISOString(),
      });
      expect(body.aiConnections.days[5]!.calls).toBe(0);
      await db.delete(aiConnectionDailyCalls);
    });
  });

  describe("revoke", () => {
    it("ends the grant an org admin revokes: the app's next call is refused", async () => {
      const { accessToken } = await connectAiApp({
        serverUrl: server.url,
        email: s.ben.email,
        organizationId: s.acmeId,
      });
      expect((await mcpInitialize(accessToken)).status).toBe(200);
      const before = personOf(await usage(s.ada.id), s.ben.id)!;
      expect(before.apps).toHaveLength(1);
      expect(before.apps[0]!.access).toBe("write");

      const api = await apiAs(server.url, s.ada.id);
      const res = await api.delete(
        `/api/organization/ai/connections/${before.apps[0]!.grantId}?organizationId=${s.acmeId}`
      );

      expect(res.status).toBe(204);
      expect((await mcpInitialize(accessToken)).status).toBe(401);
      expect(personOf(await usage(s.ada.id), s.ben.id)?.apps ?? []).toEqual([]);
      expect(
        (
          await api.delete(
            `/api/organization/ai/connections/${before.apps[0]!.grantId}?organizationId=${s.acmeId}`
          )
        ).status
      ).toBe(404);
    });
  });
});
