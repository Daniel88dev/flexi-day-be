import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { session } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { pushEnvironment, pushRegistrations } from "../../db/schema/push-registration-schema.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { notifySessionAutoClosed } from "../../services/attendance/attendanceNotifier.js";
import { apnsSender } from "../../services/push/index.js";
import { logger } from "../../middleware/logger.js";
import type { FakeApnsSender } from "../../services/push/fakeApnsSender.js";
import { authCookieFor, createTestSession } from "./helpers/authHelper.js";
import { cleanupTestData, createTestUser, type TestUser } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

vi.mock("../../services/push/index.js", async () => {
  const { createFakeApnsSender } = await import("../../services/push/fakeApnsSender.js");
  return { apnsSender: createFakeApnsSender() };
});

const fake = apnsSender as FakeApnsSender;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const firstMondayOfDecember = () => {
  const day = new Date(Date.UTC(new Date().getUTCFullYear(), 11, 1));
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  return day;
};
const MON = isoDay(firstMondayOfDecember());

const apnsToken = () => uuidv4().replace(/-/g, "").repeat(2);

type Phone = { sessionId: string; token: string; environment: pushEnvironment };

describe("push", () => {
  let server: LoopbackServer;
  let manager: TestUser;
  let requester: TestUser;
  let groupId: string;

  /** A signed-in phone of the user, registered for push the way T-67's endpoint stores it. */
  const phoneOf = async (
    user: TestUser,
    environment = pushEnvironment.Production
  ): Promise<Phone> => {
    const sessionToken = await createTestSession(user.id);
    const [row] = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.token, sessionToken));
    const phone = { sessionId: row!.id, token: apnsToken(), environment };
    await db.insert(pushRegistrations).values(phone);
    return phone;
  };

  const registrationOf = async (phone: Phone) => {
    const [row] = await db
      .select()
      .from(pushRegistrations)
      .where(eq(pushRegistrations.sessionId, phone.sessionId));
    return row;
  };

  const requestDay = async (day = MON) =>
    request(server.url)
      .post("/api/vacation/create-vacation")
      .set("Cookie", await authCookieFor(requester.id))
      .send({ groupId, from: day, to: day });

  const unreadNotice = (userId: string, readAt: Date | null = null) =>
    db.insert(notifications).values({
      id: uuidv4(),
      userId,
      type: notificationType.Comment,
      title: "Earlier",
      body: "Earlier notice",
      readAt,
    });

  const autoClose = (userId: string) =>
    notifySessionAutoClosed({
      id: uuidv4(),
      userId,
      businessDate: "2026-10-16",
      timezone: "Europe/Prague",
      closeAt: new Date("2026-10-16T20:00:00Z"),
    });

  const notificationsOf = (userId: string) =>
    db.select().from(notifications).where(eq(notifications.userId, userId));

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
    manager = await createTestUser("manager@push-e2e.test", "Mia Manager", "password123");
    requester = await createTestUser("requester@push-e2e.test", "Rey Requester", "password123");
    const organization = await ensureOrganizationForUser(manager.id);
    groupId = uuidv4();
    await db.insert(groups).values({
      id: groupId,
      organizationId: organization.id,
      groupName: "Push",
      managerUserId: manager.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(groupUsers).values({
      id: uuidv4(),
      groupId,
      userId: requester.id,
      controlledUser: true,
      adminAccess: false,
      approverAccess: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await server?.close();
    await db.delete(notifications);
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(vacation);
    await db.delete(notifications);
    await db.delete(session);
    fake.reset();
  });

  describe("request notices", () => {
    it("pushes a new request's notice to every phone the approver is signed in on", async () => {
      const first = await phoneOf(manager, pushEnvironment.Production);
      const second = await phoneOf(manager, pushEnvironment.Sandbox);

      expect((await requestDay()).status).toBe(201);

      const [notice] = await notificationsOf(manager.id);
      expect(fake.sends).toHaveLength(2);
      expect(fake.sends.map(({ token, environment }) => ({ token, environment }))).toEqual(
        expect.arrayContaining([
          { token: first.token, environment: pushEnvironment.Production },
          { token: second.token, environment: pushEnvironment.Sandbox },
        ])
      );
      for (const push of fake.sends) {
        expect(push.payload).toEqual({
          aps: { alert: { title: notice!.title, body: notice!.body }, badge: 1, sound: "default" },
          notificationId: notice!.id,
          href: notice!.href,
        });
      }
    });

    it("sets the badge to the approver's unread count, the new notice included", async () => {
      await phoneOf(manager);
      await unreadNotice(manager.id);
      await unreadNotice(manager.id);
      await unreadNotice(manager.id, new Date());

      expect((await requestDay()).status).toBe(201);

      expect(fake.sends.map((push) => push.payload.aps.badge)).toEqual([3]);
    });

    it("pushes nothing to a recipient with no registered phone", async () => {
      await phoneOf(requester);

      expect((await requestDay()).status).toBe(201);

      expect(await notificationsOf(manager.id)).toHaveLength(1);
      expect(fake.sends).toEqual([]);
    });

    it("pushes the decision to the requester's phone once the approval commits", async () => {
      const phone = await phoneOf(requester);
      expect((await requestDay()).status).toBe(201);
      const [row] = await db.select({ id: vacation.id }).from(vacation);
      fake.reset();

      const res = await request(server.url)
        .post("/api/vacation/approve")
        .set("Cookie", await authCookieFor(manager.id))
        .send({ ids: [row!.id] });

      expect(res.status).toBe(200);
      const [notice] = await notificationsOf(requester.id);
      expect(fake.sends).toEqual([
        expect.objectContaining({
          token: phone.token,
          payload: expect.objectContaining({ notificationId: notice!.id }) as unknown,
        }),
      ]);
    });

    it("still answers 201 when APNs fails the push", async () => {
      const phone = await phoneOf(manager);
      fake.answer(pushEnvironment.Production, { status: 500, reason: "InternalServerError" });

      expect((await requestDay()).status).toBe(201);

      expect(fake.sends).toHaveLength(1);
      expect(await registrationOf(phone)).toBeDefined();
    });

    it("waits at most 3 seconds for a phone APNs never answers for, and still pushes the rest", async () => {
      const stuck = await phoneOf(manager, pushEnvironment.Sandbox);
      const answered = await phoneOf(manager, pushEnvironment.Production);
      fake.answer(pushEnvironment.Sandbox, "hang");

      const started = Date.now();
      const res = await requestDay();
      const waited = Date.now() - started;

      expect(res.status).toBe(201);
      expect(waited).toBeGreaterThanOrEqual(2900);
      expect(waited).toBeLessThan(6000);
      expect(fake.sends.map((push) => push.token).sort()).toEqual(
        [stuck.token, answered.token].sort()
      );
      expect(await registrationOf(stuck)).toBeDefined();
    });
  });

  describe("the auto-closed notice", () => {
    it("is pushed passive and silent, with its notice id and href", async () => {
      const phone = await phoneOf(requester);

      await autoClose(requester.id);

      const [notice] = await notificationsOf(requester.id);
      expect(fake.sends).toEqual([
        {
          environment: phone.environment,
          token: phone.token,
          payload: {
            aps: {
              alert: { title: "Clock closed automatically", body: notice!.body },
              badge: 1,
              "interruption-level": "passive",
            },
            notificationId: notice!.id,
            href: "/my-attendance/?date=2026-10-16",
          },
        },
      ]);
    });
  });

  describe("APNs answers", () => {
    const sentTo = () => fake.sends.map((push) => push.environment);

    it("deletes the registration when APNs says the token is gone", async () => {
      const phone = await phoneOf(requester, pushEnvironment.Production);
      fake.answer(pushEnvironment.Production, { status: 410, reason: "Unregistered" });

      await autoClose(requester.id);

      expect(sentTo()).toEqual([pushEnvironment.Production]);
      expect(await registrationOf(phone)).toBeUndefined();
    });

    it("deletes the registration on an expired token", async () => {
      const phone = await phoneOf(requester);
      fake.answer(pushEnvironment.Production, { status: 410, reason: "ExpiredToken" });

      await autoClose(requester.id);

      expect(await registrationOf(phone)).toBeUndefined();
    });

    it("retries a BadDeviceToken once on the other host and stores the host that took it", async () => {
      const phone = await phoneOf(requester, pushEnvironment.Production);
      fake.answer(pushEnvironment.Production, { status: 400, reason: "BadDeviceToken" });

      await autoClose(requester.id);

      expect(sentTo()).toEqual([pushEnvironment.Production, pushEnvironment.Sandbox]);
      expect(fake.sends[1]?.payload).toEqual(fake.sends[0]?.payload);
      expect(await registrationOf(phone)).toMatchObject({
        token: phone.token,
        environment: pushEnvironment.Sandbox,
      });
    });

    it("deletes the registration when both hosts answer BadDeviceToken", async () => {
      const phone = await phoneOf(requester, pushEnvironment.Sandbox);
      fake.answer(pushEnvironment.Sandbox, { status: 400, reason: "BadDeviceToken" });
      fake.answer(pushEnvironment.Production, { status: 400, reason: "BadDeviceToken" });

      await autoClose(requester.id);

      expect(sentTo()).toEqual([pushEnvironment.Sandbox, pushEnvironment.Production]);
      expect(await registrationOf(phone)).toBeUndefined();
    });

    it("keeps the registration when the retry fails for another reason", async () => {
      const phone = await phoneOf(requester, pushEnvironment.Production);
      fake.answer(pushEnvironment.Production, { status: 400, reason: "BadDeviceToken" });
      fake.answer(pushEnvironment.Sandbox, { status: 503, reason: "ServiceUnavailable" });

      await autoClose(requester.id);

      expect(sentTo()).toEqual([pushEnvironment.Production, pushEnvironment.Sandbox]);
      expect(await registrationOf(phone)).toMatchObject({
        environment: pushEnvironment.Production,
      });
    });

    it.each([
      { status: 403, reason: "BadEnvironmentKeyIdInToken" },
      { status: 403, reason: "InvalidProviderToken" },
      { status: 403, reason: "ExpiredProviderToken" },
    ])(
      "logs a config error and never touches the registration on a $status $reason",
      async (answer) => {
        const phone = await phoneOf(requester, pushEnvironment.Sandbox);
        fake.answer(pushEnvironment.Sandbox, answer);
        const logged = vi.spyOn(logger, "error");

        await autoClose(requester.id);

        expect(logged).toHaveBeenCalledWith(
          "push.apns_config_error",
          expect.objectContaining({ sessionId: phone.sessionId, ...answer })
        );
        logged.mockRestore();
        expect(sentTo()).toEqual([pushEnvironment.Sandbox]);
        expect(await registrationOf(phone)).toMatchObject({
          token: phone.token,
          environment: pushEnvironment.Sandbox,
        });
      }
    );

    it.each([
      { status: 429, reason: "TooManyRequests" },
      { status: 500, reason: "InternalServerError" },
      { status: 503, reason: "ServiceUnavailable" },
    ])("drops the push on a $status without retrying it", async (answer) => {
      const phone = await phoneOf(requester);
      fake.answer(pushEnvironment.Production, answer);

      await autoClose(requester.id);

      expect(sentTo()).toEqual([pushEnvironment.Production]);
      expect(await registrationOf(phone)).toMatchObject({ token: phone.token });
    });

    it("pushes to the other phones when one of them refuses", async () => {
      const dead = await phoneOf(requester, pushEnvironment.Sandbox);
      const alive = await phoneOf(requester, pushEnvironment.Production);
      fake.answer(pushEnvironment.Sandbox, { status: 410, reason: "Unregistered" });

      await autoClose(requester.id);

      expect(fake.sends.map((push) => push.token).sort()).toEqual([dead.token, alive.token].sort());
      expect(await registrationOf(dead)).toBeUndefined();
      expect(await registrationOf(alive)).toBeDefined();
    });
  });
});
