import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { session, user } from "../../db/schema/auth-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { notifications } from "../../db/schema/notification-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { pushEnvironment, pushRegistrations } from "../../db/schema/push-registration-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { userSettings } from "../../db/schema/user-settings-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { disableDirectory } from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { apnsSender } from "../../services/push/index.js";
import type { FakeApnsSender } from "../../services/push/fakeApnsSender.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor, createTestSession } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs } from "./helpers/directoryWorld.js";

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

type Notice = { type: string; title: string; body: string; href: string | null };
type Checklist = {
  hidden: boolean;
  items: { key: string; done: boolean }[];
  reviewPermissions: boolean;
};

describe("The directory setup checklist and the members' notice", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await cleanupTestData();
    sentEmails.length = 0;
    fake.reset();
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  /**
   * Olga owns Acme. In Support: Jana (member), Dana (org-admin grant), Eva
   * (External worker), Karel (Deleted account, still open) and Petra (left).
   * Ada has no account.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const dana = await makeUser("Dana Delegate");
    const eva = await makeUser("Eva External");
    const karel = await makeUser("Karel Deleted");
    const petra = await makeUser("Petra Leaver");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await db
      .update(organizations)
      .set({ name: "Acme" })
      .where(eq(organizations.id, organizationId));
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, dana, eva, karel, petra]) {
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
      .set({ type: workerType.External })
      .where(eq(employments.userId, eva.id));
    await db
      .update(employments)
      .set({ accountDeletedAt: new Date("2026-09-01T10:00:00Z") })
      .where(eq(employments.userId, karel.id));
    await db.update(user).set({ deletedAt: new Date() }).where(eq(user.id, karel.id));
    await db
      .update(employments)
      .set({ endedAt: new Date("2026-03-31T12:00:00Z") })
      .where(eq(employments.userId, petra.id));
    await db.insert(employments).values({
      id: uuidv4(),
      organizationId,
      userId: null,
      name: "Ada Noaccount",
      email: "ada@example.test",
    });
    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Enterprise,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });

    const employmentOf = async (userId: string) => {
      const [row] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(and(eq(employments.userId, userId), eq(employments.organizationId, organizationId)));
      return row!.id;
    };

    return {
      organizationId,
      users: { owner, jana, dana, eva, karel, petra },
      employment: {
        jana: await employmentOf(jana.id),
        dana: await employmentOf(dana.id),
        eva: await employmentOf(eva.id),
        owner: await employmentOf(owner.id),
      },
    };
  };

  const as = (userId: string) => apiAs(server.url, userId);

  const enable = async (ownerId: string, organizationId: string, body: object = {}) => {
    const res = await (
      await as(ownerId)
    ).post(`/api/organization/directory/enable?organizationId=${organizationId}`, {
      agreementVersion: 1,
      ...body,
    });
    expect(res.status).toBe(200);
    return res;
  };

  const noticesOf = async (userId: string): Promise<Notice[]> => {
    const res = await request(server.url)
      .get("/api/notifications")
      .set("Cookie", await authCookieFor(userId));
    expect(res.status).toBe(200);
    return (res.body as Notice[]).filter((notice) => notice.type === "directory_enabled");
  };

  const profileHref = (organizationId: string, employmentId: string) =>
    `/directory/person/?organizationId=${organizationId}&employmentId=${employmentId}`;

  describe("the members' notice", () => {
    it("reaches every bound open Employment once, linked to their own profile, by no email", async () => {
      const world = await setUp();

      await enable(world.users.owner.id, world.organizationId, { tellMembers: true });

      for (const name of ["jana", "dana", "eva", "owner"] as const) {
        const notices = await noticesOf(world.users[name].id);
        expect(notices).toEqual([
          expect.objectContaining({
            title: "Acme turned on the people directory",
            body: "Check your profile and add your contact details.",
            href: profileHref(world.organizationId, world.employment[name]),
          }),
        ]);
      }
      expect(sentEmails).toEqual([]);
    });

    it("never reaches a Deleted account or a leaver", async () => {
      const world = await setUp();

      await enable(world.users.owner.id, world.organizationId, { tellMembers: true });

      for (const id of [world.users.karel.id, world.users.petra.id]) {
        expect(await db.select().from(notifications).where(eq(notifications.userId, id))).toEqual(
          []
        );
      }
    });

    it("sends nothing when the owner leaves Tell members off", async () => {
      const world = await setUp();

      await enable(world.users.owner.id, world.organizationId, { tellMembers: false });
      expect(await noticesOf(world.users.jana.id)).toEqual([]);

      await db.transaction((tx) =>
        disableDirectory({ organizationId: world.organizationId, userId: world.users.owner.id }, tx)
      );
      await enable(world.users.owner.id, world.organizationId);
      expect(await noticesOf(world.users.jana.id)).toEqual([]);
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
          alert: {
            title: "Acme turned on the people directory",
            body: "Check your profile and add your contact details.",
          },
          "interruption-level": "passive",
        },
        href: profileHref(world.organizationId, world.employment.jana),
      });
    });

    it("speaks Czech to a member who chose it", async () => {
      const world = await setUp();
      await db.insert(userSettings).values({ userId: world.users.jana.id, language: "cs" });

      await enable(world.users.owner.id, world.organizationId, { tellMembers: true });

      expect((await noticesOf(world.users.jana.id))[0]).toMatchObject({
        title: "Organizace Acme zapnula adresář lidí",
        body: "Zkontrolujte svůj profil a doplňte své kontaktní údaje.",
      });
    });

    it("writes nothing when the enable is refused", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);

      const res = await (
        await as(world.users.owner.id)
      ).post(`/api/organization/directory/enable?organizationId=${world.organizationId}`, {
        agreementVersion: 1,
        tellMembers: true,
      });

      expect(res.status).toBe(409);
      expect(await noticesOf(world.users.jana.id)).toEqual([]);
    });
  });
  describe("the setup checklist", () => {
    const checklistPath = (organizationId: string) => `/api/directory/${organizationId}/checklist`;

    const checklistOf = async (userId: string, organizationId: string): Promise<Checklist> => {
      const res = await (await as(userId)).get(checklistPath(organizationId));
      expect(res.status).toBe(200);
      return res.body as Checklist;
    };

    const ticks = (checklist: Checklist) =>
      Object.fromEntries(checklist.items.map((item) => [item.key, item.done]));

    it("shows the owner every item unticked and the review link", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);

      expect(await checklistOf(world.users.owner.id, world.organizationId)).toEqual({
        hidden: false,
        items: [
          { key: "departments", done: false },
          { key: "locations", done: false },
          { key: "hr", done: false },
          { key: "jobTitles", done: false },
        ],
        reviewPermissions: true,
      });
    });

    it("leaves assign HR and the review link to the owner", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);

      const forDana = await checklistOf(world.users.dana.id, world.organizationId);

      expect(forDana.items.map((item) => item.key)).toEqual([
        "departments",
        "locations",
        "jobTitles",
      ]);
      expect(forDana.reviewPermissions).toBe(false);
    });

    it("refuses a plain member", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);

      const res = await (await as(world.users.jana.id)).get(checklistPath(world.organizationId));

      expect(res.status).toBe(403);
      expect(res.body.errors?.[0]?.context?.code).toBe("CHECKLIST_DENIED");
    });

    it("ticks each item from the data and hides once all are done", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);
      const olga = await as(world.users.owner.id);
      const org = world.organizationId;

      expect((await olga.post(`/api/directory/${org}/departments`, { name: "Sales" })).status).toBe(
        201
      );
      expect(ticks(await checklistOf(world.users.owner.id, org))).toEqual({
        departments: true,
        locations: false,
        hr: false,
        jobTitles: false,
      });

      expect((await olga.post(`/api/directory/${org}/locations`, { name: "Prague" })).status).toBe(
        201
      );
      expect(
        (
          await olga.patch(`/api/directory/${org}/people/${world.employment.jana}`, {
            card: { jobTitle: "Accountant" },
          })
        ).status
      ).toBe(200);
      const halfway = await checklistOf(world.users.owner.id, org);
      expect(ticks(halfway)).toEqual({
        departments: true,
        locations: true,
        hr: false,
        jobTitles: true,
      });
      expect(halfway.hidden).toBe(false);
      expect((await checklistOf(world.users.dana.id, org)).hidden).toBe(true);

      expect(
        (await olga.put(`/api/directory/${org}/roles/${world.employment.jana}`, { roles: ["HR"] }))
          .status
      ).toBe(200);
      const done = await checklistOf(world.users.owner.id, org);
      expect(ticks(done).hr).toBe(true);
      expect(done.hidden).toBe(true);
    });

    it("counts no archived entry and no job title on a leaver", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);
      const olga = await as(world.users.owner.id);
      const org = world.organizationId;
      const created = await olga.post(`/api/directory/${org}/departments`, { name: "Sales" });
      expect(
        (
          await olga.patch(`/api/directory/${org}/departments/${created.body.id}`, {
            archived: true,
          })
        ).status
      ).toBe(200);
      const [petra] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(eq(employments.userId, world.users.petra.id));
      expect(
        (
          await olga.patch(`/api/directory/${org}/people/${petra!.id}`, {
            card: { jobTitle: "Former clerk" },
          })
        ).status
      ).toBe(200);

      const checklist = await checklistOf(world.users.owner.id, org);

      expect(ticks(checklist)).toMatchObject({ departments: false, jobTitles: false });
    });

    it("hides for the whole organization when anyone clicks Hide, until a re-enable", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);

      const res = await (
        await as(world.users.dana.id)
      ).post(`${checklistPath(world.organizationId)}/hide`);

      expect(res.status).toBe(200);
      expect(res.body.hidden).toBe(true);
      expect((await checklistOf(world.users.owner.id, world.organizationId)).hidden).toBe(true);

      await db.transaction((tx) =>
        disableDirectory({ organizationId: world.organizationId, userId: world.users.owner.id }, tx)
      );
      await enable(world.users.owner.id, world.organizationId);
      expect((await checklistOf(world.users.owner.id, world.organizationId)).hidden).toBe(false);
    });

    it("hides on a lapsed plan too, and refuses a plain member", async () => {
      const world = await setUp();
      await enable(world.users.owner.id, world.organizationId);
      await upsertSubscription(world.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });

      const denied = await (
        await as(world.users.jana.id)
      ).post(`${checklistPath(world.organizationId)}/hide`);
      expect(denied.status).toBe(403);

      const res = await (
        await as(world.users.owner.id)
      ).post(`${checklistPath(world.organizationId)}/hide`);
      expect(res.status).toBe(200);
      expect(res.body.hidden).toBe(true);
    });
  });
});
