import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { v4 as uuidv4 } from "uuid";
import { session, user } from "../../db/schema/auth-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { pushEnvironment, pushRegistrations } from "../../db/schema/push-registration-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { authCookieFor, createTestSession } from "./helpers/authHelper.js";
import { aiAgreementAcceptances } from "../../db/schema/ai-agreement-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { apnsSender } from "../../services/push/index.js";
import type { FakeApnsSender } from "../../services/push/fakeApnsSender.js";
import { AI_AGREEMENT_VERSION } from "../../services/aiFeatures/aiAgreement.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs, errorCode } from "./helpers/directoryWorld.js";

const sentEmails: unknown[] = [];
vi.mock("../../services/email/index.js", () => ({
  emailSender: {
    sendTemplated: (email: unknown) => {
      sentEmails.push(email);
      return Promise.resolve();
    },
  },
}));

vi.mock("../../services/push/index.js", async () => {
  const { createFakeApnsSender } = await import("../../services/push/fakeApnsSender.js");
  return { apnsSender: createFakeApnsSender() };
});

const fake = apnsSender as FakeApnsSender;

const ON = { assistantEnabled: true, aiConnectionsEnabled: false, previewOrganizationIds: [] };

describe("The Assistant setting and the AI features agreement", () => {
  let server: LoopbackServer;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await cleanupTestData();
    sentEmails.length = 0;
    fake.reset();
    config.aiFeatures = { ...ON };
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    await server?.close();
    await cleanupTestData();
  });

  /**
   * Olga owns Acme on Enterprise. In Support: Jana (member), Dana (org admin),
   * Karel (Deleted account, still open) and Petra (left).
   */
  const setUp = async (plan: subscriptionPlan | null = subscriptionPlan.Enterprise) => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const dana = await makeUser("Dana Delegate");
    const karel = await makeUser("Karel Deleted");
    const petra = await makeUser("Petra Leaver");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await db
      .update(organizations)
      .set({ name: "Acme" })
      .where(eq(organizations.id, organizationId));
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, dana, karel, petra]) {
      await addMember(support, person.id);
      await syncEmployment(organizationId, person.id);
    }
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    await db
      .update(employments)
      .set({ accountDeletedAt: new Date("2026-09-01T10:00:00Z") })
      .where(eq(employments.userId, karel.id));
    await db.update(user).set({ deletedAt: new Date() }).where(eq(user.id, karel.id));
    await db
      .update(employments)
      .set({ endedAt: new Date("2026-03-31T12:00:00Z") })
      .where(eq(employments.userId, petra.id));
    if (plan) {
      await upsertSubscription(organizationId, {
        plan,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
    }
    return { organizationId, users: { owner, jana, dana, karel, petra } };
  };

  const as = (userId: string) => apiAs(server.url, userId);

  const enable = async (userId: string, organizationId: string, body: object = {}) =>
    (await as(userId)).post(
      `/api/organization/ai/assistant/enable?organizationId=${organizationId}`,
      {
        agreementVersion: AI_AGREEMENT_VERSION,
        tellMembers: false,
        ...body,
      }
    );

  const disable = async (userId: string, organizationId: string) =>
    (await as(userId)).post(
      `/api/organization/ai/assistant/disable?organizationId=${organizationId}`
    );

  const acceptancesOf = (organizationId: string) =>
    db
      .select()
      .from(aiAgreementAcceptances)
      .where(eq(aiAgreementAcceptances.organizationId, organizationId));

  describe("the agreement", () => {
    it("refuses a turn-on without the current version and writes nothing", async () => {
      const world = await setUp();

      const missing = await enable(world.users.owner.id, world.organizationId, {
        agreementVersion: undefined,
      });
      expect(missing.status).toBe(422);
      const stale = await enable(world.users.owner.id, world.organizationId, {
        agreementVersion: AI_AGREEMENT_VERSION + 1,
      });
      expect(stale.status).toBe(409);
      expect(errorCode(stale)).toBe("AGREEMENT_VERSION_STALE");

      expect(await acceptancesOf(world.organizationId)).toEqual([]);
      const state = await (
        await as(world.users.owner.id)
      ).get(`/api/organization/ai?organizationId=${world.organizationId}`);
      expect(state.body.assistant.enabled).toBe(false);
    });

    it("records one acceptance per version, however often the owner turns it on", async () => {
      const world = await setUp();

      const first = await enable(world.users.owner.id, world.organizationId);
      expect(first.status).toBe(200);
      expect(first.body.assistant.enabled).toBe(true);
      expect(first.body.agreement).toMatchObject({
        currentVersion: AI_AGREEMENT_VERSION,
        acceptedVersion: AI_AGREEMENT_VERSION,
        acceptedByName: "Olga Owner",
        newVersionReady: false,
      });

      expect((await disable(world.users.owner.id, world.organizationId)).status).toBe(200);
      expect((await enable(world.users.owner.id, world.organizationId)).status).toBe(200);

      const rows = await acceptancesOf(world.organizationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: AI_AGREEMENT_VERSION,
        acceptedByUserId: world.users.owner.id,
      });
    });

    it("refuses a second turn-on while the Assistant is on", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);

      const again = await enable(world.users.owner.id, world.organizationId);
      expect(again.status).toBe(409);
      expect(errorCode(again)).toBe("ASSISTANT_ALREADY_ON");
    });

    it("asks the owner to accept a raised version while the Assistant is on, and pauses nothing", async () => {
      const world = await setUp();
      await db
        .update(organizations)
        .set({ assistantEnabled: true, assistantEnabledAt: new Date() })
        .where(eq(organizations.id, world.organizationId));
      await db.insert(aiAgreementAcceptances).values({
        id: generateRandomUUID(),
        organizationId: world.organizationId,
        version: AI_AGREEMENT_VERSION - 1,
        acceptedByUserId: world.users.owner.id,
      });

      const owner = await as(world.users.owner.id);
      const before = await owner.get(`/api/organization/ai?organizationId=${world.organizationId}`);
      expect(before.body.assistant.enabled).toBe(true);
      expect(before.body.agreement).toMatchObject({
        acceptedVersion: AI_AGREEMENT_VERSION - 1,
        newVersionReady: true,
      });
      const availability = await owner.get("/api/ai-features/availability");
      expect(availability.body.organizations).toEqual([
        expect.objectContaining({
          organizationId: world.organizationId,
          newAgreementVersionReady: true,
        }),
      ]);
      const forAdmin = await (await as(world.users.dana.id)).get("/api/ai-features/availability");
      expect(forAdmin.body.organizations[0].newAgreementVersionReady).toBe(false);

      const accepted = await owner.post(
        `/api/organization/ai/agreement?organizationId=${world.organizationId}`,
        { agreementVersion: AI_AGREEMENT_VERSION }
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.agreement).toMatchObject({
        acceptedVersion: AI_AGREEMENT_VERSION,
        newVersionReady: false,
      });
      const again = await owner.post(
        `/api/organization/ai/agreement?organizationId=${world.organizationId}`,
        { agreementVersion: AI_AGREEMENT_VERSION }
      );
      expect(again.status).toBe(200);
      expect(await acceptancesOf(world.organizationId)).toHaveLength(2);
      const after = await owner.get("/api/ai-features/availability");
      expect(after.body.organizations[0].newAgreementVersionReady).toBe(false);
    });

    it("refuses accepting the agreement while the Assistant is off", async () => {
      const world = await setUp();

      const res = await (
        await as(world.users.owner.id)
      ).post(`/api/organization/ai/agreement?organizationId=${world.organizationId}`, {
        agreementVersion: AI_AGREEMENT_VERSION,
      });

      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("AI_FEATURES_OFF");
    });
  });

  describe("who may change it", () => {
    it("lets only the owner turn it on or off, and shows org admins the owner's name", async () => {
      const world = await setUp();

      const byAdmin = await enable(world.users.dana.id, world.organizationId);
      expect(byAdmin.status).toBe(403);
      expect(errorCode(byAdmin)).toBe("OWNER_ONLY");
      const byMember = await enable(world.users.jana.id, world.organizationId);
      expect(byMember.status).toBe(403);

      const state = await (
        await as(world.users.dana.id)
      ).get(`/api/organization/ai?organizationId=${world.organizationId}`);
      expect(state.status).toBe(200);
      expect(state.body).toMatchObject({
        isOwner: false,
        ownerName: "Olga Owner",
        plan: "ENTERPRISE",
        assistant: { enabled: false, planAllows: true },
      });
      expect(
        (
          await (
            await as(world.users.jana.id)
          ).get(`/api/organization/ai?organizationId=${world.organizationId}`)
        ).status
      ).toBe(403);

      expect((await enable(world.users.owner.id, world.organizationId)).status).toBe(200);
      const offByAdmin = await disable(world.users.dana.id, world.organizationId);
      expect(offByAdmin.status).toBe(403);
      expect(errorCode(offByAdmin)).toBe("OWNER_ONLY");
      const off = await disable(world.users.owner.id, world.organizationId);
      expect(off.status).toBe(200);
      expect(off.body.assistant.enabled).toBe(false);
      expect((await disable(world.users.owner.id, world.organizationId)).status).toBe(200);
    });

    it("needs Enterprise to turn it on, and lets a lapsed owner turn it off", async () => {
      for (const [plan, name] of [
        [subscriptionPlan.Pro, "PRO"],
        [null, "FREE"],
      ] as const) {
        await cleanupTestData();
        const world = await setUp(plan);

        const res = await enable(world.users.owner.id, world.organizationId);
        expect(res.status).toBe(402);
        expect(errorCode(res)).toBe("ASSISTANT_PLAN_REQUIRED");
        const state = await (
          await as(world.users.owner.id)
        ).get(`/api/organization/ai?organizationId=${world.organizationId}`);
        expect(state.body).toMatchObject({
          plan: name,
          assistant: { enabled: false, planAllows: false },
        });
        expect(await acceptancesOf(world.organizationId)).toEqual([]);

        await db
          .update(organizations)
          .set({ assistantEnabled: true })
          .where(eq(organizations.id, world.organizationId));
        expect((await disable(world.users.owner.id, world.organizationId)).status).toBe(200);
      }
    });

    it("answers 404 to a turn-on while the Assistant is unavailable, and opens for a preview organization", async () => {
      const world = await setUp();
      config.aiFeatures = { ...ON, assistantEnabled: false };

      expect((await enable(world.users.owner.id, world.organizationId)).status).toBe(404);
      expect(await acceptancesOf(world.organizationId)).toEqual([]);

      config.aiFeatures = {
        ...ON,
        assistantEnabled: false,
        previewOrganizationIds: [world.organizationId],
      };
      expect((await enable(world.users.owner.id, world.organizationId)).status).toBe(200);
    });
  });

  describe("Tell members", () => {
    type Notice = { type: string; title: string; body: string; href: string | null };

    const noticesOf = async (userId: string): Promise<Notice[]> => {
      const res = await request(server.url)
        .get("/api/notifications")
        .set("Cookie", await authCookieFor(userId));
      expect(res.status).toBe(200);
      return (res.body as Notice[]).filter((notice) => notice.type === "assistant_enabled");
    };

    it("sends every member the notice in the app, by no email, with the text the AI card copies", async () => {
      const world = await setUp();
      await db
        .insert(userSettings)
        .values({ userId: world.users.jana.id, language: appLanguage.Czech });

      const res = await enable(world.users.owner.id, world.organizationId, { tellMembers: true });
      expect(res.status).toBe(200);
      const copyable = res.body.memberNotice.assistant;

      expect(await noticesOf(world.users.dana.id)).toEqual([
        expect.objectContaining({ ...copyable.en, href: null }),
      ]);
      expect(await noticesOf(world.users.jana.id)).toEqual([
        expect.objectContaining({ ...copyable.cs, href: null }),
      ]);
      expect(copyable.en).toEqual({
        title: "Acme turned on the Assistant.",
        body: "Ask it about your time off, attendance and colleagues. It's an AI run by Anthropic, which keeps chats in the US and may process them elsewhere. It sees your messages and what you can see in Flexi Day. Chats are kept 180 days, and you can delete them. Owners and admins see how much you use it and how many messages were refused, never what you wrote.",
      });
      expect(copyable.cs.title).toBe("V organizaci Acme je zapnutý Asistent.");
      expect(sentEmails).toEqual([]);
    });

    it("skips the owner who turned it on, Deleted accounts and leavers", async () => {
      const world = await setUp();

      await enable(world.users.owner.id, world.organizationId, { tellMembers: true });

      for (const id of [world.users.owner.id, world.users.karel.id, world.users.petra.id]) {
        expect(
          await db
            .select()
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, id),
                eq(notifications.type, notificationType.AssistantEnabled)
              )
            )
        ).toEqual([]);
      }
    });

    it("pushes the notice to the member's phone, passively", async () => {
      const world = await setUp();
      const token = await createTestSession(world.users.jana.id);
      const [phone] = await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.token, token));
      await db.insert(pushRegistrations).values({
        sessionId: phone!.id,
        token: uuidv4().replace(/-/g, "").repeat(2),
        environment: pushEnvironment.Production,
      });

      await enable(world.users.owner.id, world.organizationId, { tellMembers: true });

      expect(fake.sends).toHaveLength(1);
      expect(fake.sends[0]?.payload).toMatchObject({
        aps: {
          alert: { title: "Acme turned on the Assistant." },
          "interruption-level": "passive",
        },
      });
    });

    it("sends nothing without Tell members, or when the turn-on is refused", async () => {
      const world = await setUp();

      await enable(world.users.owner.id, world.organizationId, { tellMembers: false });
      expect(await noticesOf(world.users.jana.id)).toEqual([]);

      const refused = await enable(world.users.owner.id, world.organizationId, {
        tellMembers: true,
      });
      expect(refused.status).toBe(409);
      expect(await noticesOf(world.users.jana.id)).toEqual([]);
      expect(fake.sends).toEqual([]);
    });
  });
});
