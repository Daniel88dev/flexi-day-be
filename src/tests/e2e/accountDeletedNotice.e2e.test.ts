import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { notifications } from "../../db/schema/notification-schema.js";
import { session } from "../../db/schema/auth-schema.js";
import { pushEnvironment, pushRegistrations } from "../../db/schema/push-registration-schema.js";
import { userSettings } from "../../db/schema/user-settings-schema.js";
import { apnsSender } from "../../services/push/index.js";
import type { FakeApnsSender } from "../../services/push/fakeApnsSender.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import {
  WEB_TEST_PASSWORD,
  authCookieFor,
  createTestSession,
  createWebUser,
  webSessionCookieFor,
} from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

type SentEmail = { to: string; template: string };
const sentEmails: SentEmail[] = [];
vi.mock("../../services/email/index.js", () => ({
  emailSender: {
    sendTemplated: (email: SentEmail) => {
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

describe("the account_deleted notice", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    await resetReportData();
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
  });

  beforeEach(() => {
    sentEmails.length = 0;
    fake.reset();
  });

  /**
   * Olga owns Acme. Adam is its delegated org admin. Mia manages Support, where
   * Jana and Petra are members. Otto belongs to nothing of Acme's.
   */
  const setUp = async ({ janaIsAdmin = false } = {}) => {
    const owner = await makeUser("Olga Owner");
    const admin = await makeUser("Adam Admin");
    const manager = await makeUser("Mia Manager");
    const member = await makeUser("Petra Member");
    const outsider = await makeUser("Otto Outsider");
    const jana = await createWebUser("Jana Nováková");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await db
      .update(organizations)
      .set({ name: "Acme" })
      .where(eq(organizations.id, organizationId));
    await db.insert(organizationUsers).values({
      id: uuidv4(),
      organizationId,
      userId: admin.id,
      grantedByUserId: owner.id,
    });
    const supportId = await makeGroup("Support", manager.id, { organizationOwnerId: owner.id });
    await addMember(supportId, jana.id);
    await addMember(supportId, member.id);
    await makeGroup("Outsiders", outsider.id);
    if (janaIsAdmin) {
      await db.insert(organizationUsers).values({
        id: uuidv4(),
        organizationId,
        userId: jana.id,
        grantedByUserId: owner.id,
      });
    }
    for (const id of [admin.id, manager.id, member.id, jana.id]) {
      await syncEmployment(organizationId, id);
    }
    const [employment] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, jana.id)));
    return {
      owner,
      admin,
      manager,
      member,
      outsider,
      jana,
      organizationId,
      supportId,
      employmentId: employment!.id,
    };
  };

  const deleteAccount = async (email: string) => {
    const cookie = await webSessionCookieFor(server.url, email);
    return request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", cookie)
      .send({ password: WEB_TEST_PASSWORD });
  };

  const noticesOf = async (userId: string): Promise<Notice[]> => {
    const res = await request(server.url)
      .get("/api/notifications")
      .set("Cookie", await authCookieFor(userId));
    expect(res.status).toBe(200);
    return (res.body as Notice[]).filter((notice) => notice.type === "account_deleted");
  };

  it("reaches the owner, the org admin and the group's manager once each, by no email", async () => {
    const world = await setUp();

    expect((await deleteAccount(world.jana.email)).status).toBe(204);

    for (const recipient of [world.owner, world.admin, world.manager]) {
      const notices = await noticesOf(recipient.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        title: "Jana Nováková deleted their account",
        body: "Their employment in Acme is still open.",
      });
    }
    expect(await noticesOf(world.member.id)).toEqual([]);
    expect(await noticesOf(world.outsider.id)).toEqual([]);
    expect(sentEmails).toEqual([]);
  });

  it("never reaches the deleted person, even as an org admin", async () => {
    const world = await setUp({ janaIsAdmin: true });

    expect((await deleteAccount(world.jana.email)).status).toBe(204);

    expect(
      await db.select().from(notifications).where(eq(notifications.userId, world.jana.id))
    ).toEqual([]);
    expect(await noticesOf(world.admin.id)).toHaveLength(1);
  });

  it("pushes each notice once to the recipient's phone", async () => {
    const world = await setUp();
    const token = await createTestSession(world.owner.id);
    const [phone] = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.token, token));
    await db.insert(pushRegistrations).values({
      sessionId: phone!.id,
      token: uuidv4().replace(/-/g, "").repeat(2),
      environment: pushEnvironment.Production,
    });

    expect((await deleteAccount(world.jana.email)).status).toBe(204);

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]?.payload.aps.alert).toEqual({
      title: "Jana Nováková deleted their account",
      body: "Their employment in Acme is still open.",
    });
  });

  it("tells the owner which group they now manage", async () => {
    const world = await setUp();
    await makeGroup("Night shift", world.jana.id, { organizationOwnerId: world.owner.id });

    expect((await deleteAccount(world.jana.email)).status).toBe(204);

    const [ownerNotice] = await noticesOf(world.owner.id);
    expect(ownerNotice?.body).toBe(
      "Their employment in Acme is still open. You now manage Night shift."
    );
    const [adminNotice] = await noticesOf(world.admin.id);
    expect(adminNotice?.body).toBe("Their employment in Acme is still open.");
  });

  it("links admins to the People card row and a manager to the group's member list", async () => {
    const world = await setUp();

    expect((await deleteAccount(world.jana.email)).status).toBe(204);

    const peopleCard = `/organization/?organizationId=${world.organizationId}&employmentId=${world.employmentId}`;
    expect((await noticesOf(world.owner.id))[0]?.href).toBe(peopleCard);
    expect((await noticesOf(world.admin.id))[0]?.href).toBe(peopleCard);
    expect((await noticesOf(world.manager.id))[0]?.href).toBe(
      `/groups/detail/?groupId=${world.supportId}&tab=members`
    );
  });

  it("speaks Czech to a recipient who chose it", async () => {
    const world = await setUp();
    await makeGroup("Noční směna", world.jana.id, { organizationOwnerId: world.owner.id });
    await db.insert(userSettings).values({ userId: world.owner.id, language: "cs" });

    expect((await deleteAccount(world.jana.email)).status).toBe(204);

    expect((await noticesOf(world.owner.id))[0]).toMatchObject({
      title: "Jana Nováková smazal(a) svůj účet",
      body: "Pracovní poměr v organizaci Acme zůstává otevřený. Nyní spravuješ skupinu Noční směna.",
    });
  });

  it("sends one notice to someone who shares two organizations with the person", async () => {
    const world = await setUp();
    const betaGroupId = await makeGroup("Beta crew", world.manager.id);
    await db
      .update(organizations)
      .set({ name: "Beta" })
      .where(eq(organizations.ownerUserId, world.manager.id));
    await addMember(betaGroupId, world.jana.id);
    const [beta] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.ownerUserId, world.manager.id));
    await syncEmployment(beta!.id, world.jana.id);

    expect((await deleteAccount(world.jana.email)).status).toBe(204);

    const notices = await noticesOf(world.manager.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toBe("Their employments in Acme and Beta are still open.");
    expect(notices[0]?.href).toMatch(`/organization/?organizationId=${beta!.id}&employmentId=`);
  });

  it("writes nothing when a blocker refuses the deletion", async () => {
    const world = await setUp();
    const ownGroupId = await makeGroup("Jana's team", world.jana.id);
    await addMember(ownGroupId, world.member.id);

    expect((await deleteAccount(world.jana.email)).status).toBe(409);

    for (const recipient of [world.owner, world.admin, world.manager, world.member]) {
      expect(await noticesOf(recipient.id)).toEqual([]);
    }
  });
});
