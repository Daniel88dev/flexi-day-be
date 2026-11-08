import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { aiAgreementAcceptances } from "../../db/schema/ai-agreement-schema.js";
import { aiConnectionsChanges } from "../../db/schema/ai-connections-change-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { apnsSender } from "../../services/push/index.js";
import type { FakeApnsSender } from "../../services/push/fakeApnsSender.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { AI_AGREEMENT_VERSION } from "../../services/aiFeatures/aiAgreement.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs, errorCode } from "./helpers/directoryWorld.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

vi.mock("../../services/push/index.js", async () => {
  const { createFakeApnsSender } = await import("../../services/push/fakeApnsSender.js");
  return { apnsSender: createFakeApnsSender() };
});

const fake = apnsSender as FakeApnsSender;

const ON = { assistantEnabled: false, aiConnectionsEnabled: true, previewOrganizationIds: [] };

describe("The AI connections setting", () => {
  let server: LoopbackServer;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await cleanupTestData();
    config.aiFeatures = { ...ON };
    fake.reset();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    await server?.close();
    await cleanupTestData();
  });

  /** Olga owns Acme. In Support: Jana (member) and Dana (org admin). */
  const setUp = async (
    plan: subscriptionPlan | null = subscriptionPlan.Pro,
    subscription: { status: subscriptionStatus; graceEndsAt: Date | null } = {
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    }
  ) => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const dana = await makeUser("Dana Delegate");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await db
      .update(organizations)
      .set({ name: "Acme" })
      .where(eq(organizations.id, organizationId));
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, dana]) {
      await addMember(support, person.id);
      await syncEmployment(organizationId, person.id);
    }
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    if (plan) {
      await upsertSubscription(organizationId, { plan, ...subscription });
    }
    return { organizationId, users: { owner, jana, dana } };
  };

  const as = (userId: string) => apiAs(server.url, userId);
  const path = (organizationId: string, action: string) =>
    `/api/organization/ai/connections/${action}?organizationId=${organizationId}`;

  const enable = async (userId: string, organizationId: string, body: object = {}) =>
    (await as(userId)).post(path(organizationId, "enable"), {
      level: "read",
      agreementVersion: AI_AGREEMENT_VERSION,
      tellMembers: false,
      ...body,
    });
  const setLevel = async (userId: string, organizationId: string, level: string) =>
    (await as(userId)).post(path(organizationId, "level"), { level });
  const disable = async (userId: string, organizationId: string) =>
    (await as(userId)).post(path(organizationId, "disable"));
  const settingsAs = async (userId: string, organizationId: string) =>
    (await as(userId)).get(`/api/organization/ai?organizationId=${organizationId}`);

  const acceptancesOf = (organizationId: string) =>
    db
      .select()
      .from(aiAgreementAcceptances)
      .where(eq(aiAgreementAcceptances.organizationId, organizationId));
  const changesOf = (organizationId: string) =>
    db
      .select({
        before: aiConnectionsChanges.before,
        after: aiConnectionsChanges.after,
        changedByUserId: aiConnectionsChanges.changedByUserId,
      })
      .from(aiConnectionsChanges)
      .where(eq(aiConnectionsChanges.organizationId, organizationId))
      .orderBy(asc(aiConnectionsChanges.createdAt));

  describe("turning it on", () => {
    it("is Off by default and shows the plan allows it on Pro", async () => {
      const world = await setUp();

      const res = await settingsAs(world.users.owner.id, world.organizationId);

      expect(res.status).toBe(200);
      expect(res.body.aiConnections).toEqual({ level: "off", planAllows: true });
    });

    it("accepts the agreement the first time and starts at the chosen level", async () => {
      const world = await setUp();

      const res = await enable(world.users.owner.id, world.organizationId, { level: "write" });

      expect(res.status).toBe(200);
      expect(res.body.aiConnections.level).toBe("write");
      expect(res.body.agreement).toMatchObject({
        acceptedVersion: AI_AGREEMENT_VERSION,
        acceptedByName: "Olga Owner",
      });
      const rows = await acceptancesOf(world.organizationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: AI_AGREEMENT_VERSION,
        acceptedByUserId: world.users.owner.id,
      });
      expect(await changesOf(world.organizationId)).toEqual([
        { before: "off", after: "write", changedByUserId: world.users.owner.id },
      ]);
    });

    it("writes no second acceptance when the Assistant already accepted this version", async () => {
      const world = await setUp(subscriptionPlan.Enterprise);
      config.aiFeatures = { ...ON, assistantEnabled: true };
      const assistant = await (
        await as(world.users.owner.id)
      ).post(`/api/organization/ai/assistant/enable?organizationId=${world.organizationId}`, {
        agreementVersion: AI_AGREEMENT_VERSION,
      });
      expect(assistant.status).toBe(200);

      const res = await enable(world.users.owner.id, world.organizationId);

      expect(res.status).toBe(200);
      expect(res.body.aiConnections.level).toBe("read");
      expect(await acceptancesOf(world.organizationId)).toHaveLength(1);
    });

    it("refuses a stale agreement version, a second turn-on and an unknown level", async () => {
      const world = await setUp();

      const stale = await enable(world.users.owner.id, world.organizationId, {
        agreementVersion: AI_AGREEMENT_VERSION + 1,
      });
      expect(stale.status).toBe(409);
      expect(errorCode(stale)).toBe("AGREEMENT_VERSION_STALE");
      expect(await acceptancesOf(world.organizationId)).toEqual([]);
      expect(await changesOf(world.organizationId)).toEqual([]);

      const off = await enable(world.users.owner.id, world.organizationId, { level: "off" });
      expect(off.status).toBe(422);

      expect((await enable(world.users.owner.id, world.organizationId)).status).toBe(200);
      const again = await enable(world.users.owner.id, world.organizationId, { level: "write" });
      expect(again.status).toBe(409);
      expect(errorCode(again)).toBe("AI_CONNECTIONS_ALREADY_ON");
      expect(
        (await settingsAs(world.users.owner.id, world.organizationId)).body.aiConnections
      ).toMatchObject({ level: "read" });
    });
  });

  describe("changing the level", () => {
    it("raises Read only to Read and write with a change log entry and no new acceptance", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);

      const res = await setLevel(world.users.owner.id, world.organizationId, "write");

      expect(res.status).toBe(200);
      expect(res.body.aiConnections.level).toBe("write");
      expect(await acceptancesOf(world.organizationId)).toHaveLength(1);
      expect(await changesOf(world.organizationId)).toEqual([
        { before: "off", after: "read", changedByUserId: world.users.owner.id },
        { before: "read", after: "write", changedByUserId: world.users.owner.id },
      ]);
    });

    it("raises with no agreement even after the agreement version was raised", async () => {
      const world = await setUp();
      await db
        .update(organizations)
        .set({ aiConnections: aiConnectionsLevel.Read })
        .where(eq(organizations.id, world.organizationId));
      await db.insert(aiAgreementAcceptances).values({
        id: generateRandomUUID(),
        organizationId: world.organizationId,
        version: AI_AGREEMENT_VERSION - 1,
        acceptedByUserId: world.users.owner.id,
      });

      const res = await setLevel(world.users.owner.id, world.organizationId, "write");

      expect(res.status).toBe(200);
      expect(await acceptancesOf(world.organizationId)).toHaveLength(1);
    });

    it("lowers to Read only and turns off, logging each change and nothing for a repeat", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId, { level: "write" });

      const lowered = await setLevel(world.users.owner.id, world.organizationId, "read");
      expect(lowered.status).toBe(200);
      expect(lowered.body.aiConnections.level).toBe("read");
      expect((await setLevel(world.users.owner.id, world.organizationId, "read")).status).toBe(200);
      const off = await disable(world.users.owner.id, world.organizationId);
      expect(off.status).toBe(200);
      expect(off.body.aiConnections.level).toBe("off");
      expect((await disable(world.users.owner.id, world.organizationId)).status).toBe(200);

      expect((await changesOf(world.organizationId)).map((c) => [c.before, c.after])).toEqual([
        ["off", "write"],
        ["write", "read"],
        ["read", "off"],
      ]);
    });

    it("refuses a level change while AI connections are off", async () => {
      const world = await setUp();

      const res = await setLevel(world.users.owner.id, world.organizationId, "write");

      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("AI_CONNECTIONS_OFF");
      expect(await changesOf(world.organizationId)).toEqual([]);
    });
  });

  describe("who may change it", () => {
    it("lets only the owner change it, and shows org admins the owner's name", async () => {
      const world = await setUp();

      for (const id of [world.users.dana.id, world.users.jana.id]) {
        const res = await enable(id, world.organizationId);
        expect(res.status).toBe(403);
      }
      expect(errorCode(await enable(world.users.dana.id, world.organizationId))).toBe("OWNER_ONLY");
      const state = await settingsAs(world.users.dana.id, world.organizationId);
      expect(state.body).toMatchObject({
        isOwner: false,
        ownerName: "Olga Owner",
        aiConnections: { level: "off", planAllows: true },
      });

      await enable(world.users.owner.id, world.organizationId);
      const raise = await setLevel(world.users.dana.id, world.organizationId, "write");
      expect(raise.status).toBe(403);
      expect(errorCode(raise)).toBe("OWNER_ONLY");
      const off = await disable(world.users.dana.id, world.organizationId);
      expect(off.status).toBe(403);
      expect(errorCode(off)).toBe("OWNER_ONLY");
      expect(await changesOf(world.organizationId)).toHaveLength(1);
    });

    it("works on every Paid plan, grace included", async () => {
      for (const [plan, subscription] of [
        [subscriptionPlan.Enterprise, { status: subscriptionStatus.Active, graceEndsAt: null }],
        [
          subscriptionPlan.Pro,
          {
            status: subscriptionStatus.PastDue,
            graceEndsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
          },
        ],
      ] as const) {
        await cleanupTestData();
        const world = await setUp(plan, subscription);

        const res = await enable(world.users.owner.id, world.organizationId);

        expect(res.status).toBe(200);
        expect(res.body.aiConnections).toEqual({ level: "read", planAllows: true });
      }
    });

    it("refuses Free, and lets a lapsed owner lower it or turn it off but not raise it", async () => {
      const world = await setUp(null);

      const res = await enable(world.users.owner.id, world.organizationId);
      expect(res.status).toBe(402);
      expect(errorCode(res)).toBe("AI_CONNECTIONS_PLAN_REQUIRED");
      const state = await settingsAs(world.users.owner.id, world.organizationId);
      expect(state.body).toMatchObject({
        plan: "FREE",
        aiConnections: { level: "off", planAllows: false },
      });
      expect(await acceptancesOf(world.organizationId)).toEqual([]);

      await db
        .update(organizations)
        .set({ aiConnections: aiConnectionsLevel.Read })
        .where(eq(organizations.id, world.organizationId));
      const raise = await setLevel(world.users.owner.id, world.organizationId, "write");
      expect(raise.status).toBe(402);
      await db
        .update(organizations)
        .set({ aiConnections: aiConnectionsLevel.Write })
        .where(eq(organizations.id, world.organizationId));
      expect((await setLevel(world.users.owner.id, world.organizationId, "read")).status).toBe(200);
      expect((await disable(world.users.owner.id, world.organizationId)).status).toBe(200);
    });

    it("answers 404 to raising while AI connections are unavailable, and still lets the owner lower", async () => {
      const world = await setUp();
      config.aiFeatures = { ...ON, aiConnectionsEnabled: false };

      expect((await enable(world.users.owner.id, world.organizationId)).status).toBe(404);
      await db
        .update(organizations)
        .set({ aiConnections: aiConnectionsLevel.Read })
        .where(eq(organizations.id, world.organizationId));
      expect((await setLevel(world.users.owner.id, world.organizationId, "write")).status).toBe(
        404
      );
      expect((await disable(world.users.owner.id, world.organizationId)).status).toBe(200);

      config.aiFeatures = {
        ...ON,
        aiConnectionsEnabled: false,
        previewOrganizationIds: [world.organizationId],
      };
      expect((await enable(world.users.owner.id, world.organizationId)).status).toBe(200);
    });
  });

  describe("the agreement while only AI connections are on", () => {
    it("asks the owner to accept a raised version, and accepts it", async () => {
      const world = await setUp();
      await db
        .update(organizations)
        .set({ aiConnections: aiConnectionsLevel.Read })
        .where(eq(organizations.id, world.organizationId));
      await db.insert(aiAgreementAcceptances).values({
        id: generateRandomUUID(),
        organizationId: world.organizationId,
        version: AI_AGREEMENT_VERSION - 1,
        acceptedByUserId: world.users.owner.id,
      });
      const owner = await as(world.users.owner.id);

      expect(
        (await settingsAs(world.users.owner.id, world.organizationId)).body.agreement
      ).toMatchObject({ newVersionReady: true });
      const availability = await owner.get("/api/ai-features/availability");
      expect(availability.body.organizations[0].newAgreementVersionReady).toBe(true);

      const accepted = await owner.post(
        `/api/organization/ai/agreement?organizationId=${world.organizationId}`,
        { agreementVersion: AI_AGREEMENT_VERSION }
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.agreement).toMatchObject({
        acceptedVersion: AI_AGREEMENT_VERSION,
        newVersionReady: false,
      });
    });
  });

  describe("Tell members", () => {
    type Notice = { type: string; title: string; body: string; href: string | null };

    const noticesOf = async (userId: string): Promise<Notice[]> => {
      const res = await (await as(userId)).get("/api/notifications");
      expect(res.status).toBe(200);
      return (res.body as Notice[]).filter((notice) => notice.type === "ai_connections_enabled");
    };

    it("sends every member the notice in their language, with the text the AI card copies", async () => {
      const world = await setUp();
      await db
        .insert(userSettings)
        .values({ userId: world.users.jana.id, language: appLanguage.Czech });

      const res = await enable(world.users.owner.id, world.organizationId, { tellMembers: true });
      expect(res.status).toBe(200);
      const copyable = res.body.memberNotice.aiConnections;

      expect(copyable.en).toEqual({
        title: "Acme allows AI connections.",
        body: "You can connect an AI app you use, such as Claude or ChatGPT, in Settings. What it reads goes to that app's company under your own agreement with them.",
      });
      expect(copyable.cs.title).toBe("V organizaci Acme jsou povolená AI připojení.");
      expect(await noticesOf(world.users.dana.id)).toEqual([
        expect.objectContaining({ ...copyable.en, href: "/settings/" }),
      ]);
      expect(await noticesOf(world.users.jana.id)).toEqual([
        expect.objectContaining({ ...copyable.cs, href: "/settings/" }),
      ]);
      expect(await noticesOf(world.users.owner.id)).toEqual([]);
      expect(fake.sends).toEqual([]);
    });

    it("sends nothing without Tell members, or when raising the level", async () => {
      const world = await setUp();

      await enable(world.users.owner.id, world.organizationId, { tellMembers: false });
      await setLevel(world.users.owner.id, world.organizationId, "write");

      expect(await noticesOf(world.users.jana.id)).toEqual([]);
    });
  });
});
