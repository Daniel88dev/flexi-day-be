import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { generateId } from "better-auth";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { account, session, twoFactor, user } from "../../db/schema/auth-schema.js";
import {
  calendarCapability,
  calendarConnection,
  calendarProvider,
} from "../../db/schema/calendar-connection-schema.js";
import { calendarSync } from "../../db/schema/calendar-sync-schema.js";
import { pushEnvironment, pushRegistrations } from "../../db/schema/push-registration-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { userBirthdays } from "../../db/schema/user-birthday-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { makeUser } from "./helpers/reportFixtures.js";

const ROUTE = "/api/users/me/export";

const marker = (label: string) => `SECRET-${label}-${uuidv4()}`;

describe("account export", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  it("needs a session", async () => {
    expect((await request(server.url).get(ROUTE)).status).toBe(401);
  });

  describe("a user with every kind of account data", () => {
    const secrets: string[] = [];
    let me: { id: string; name: string };
    let cookie: string;
    let body: Record<string, unknown>;
    let raw: string;
    let disposition: string | undefined;

    const secret = (label: string) => {
      const value = marker(label);
      secrets.push(value);
      return value;
    };

    beforeAll(async () => {
      me = await makeUser("Ada Export");
      await db
        .update(user)
        .set({ image: "https://example.test/ada.png", twoFactorEnabled: true })
        .where(eq(user.id, me.id));
      cookie = await authCookieFor(me.id);

      await db.insert(account).values([
        {
          id: uuidv4(),
          userId: me.id,
          providerId: "credential",
          accountId: me.id,
          password: secret("password-hash"),
          createdAt: new Date("2026-01-02T10:00:00Z"),
          updatedAt: new Date("2026-01-02T10:00:00Z"),
        },
        {
          id: uuidv4(),
          userId: me.id,
          providerId: "google",
          accountId: "google-subject-123",
          accessToken: secret("google-access"),
          refreshToken: secret("google-refresh"),
          idToken: secret("google-id"),
          scope: "openid email profile",
          createdAt: new Date("2026-02-03T10:00:00Z"),
          updatedAt: new Date("2026-02-03T10:00:00Z"),
        },
      ]);

      await db.insert(twoFactor).values({
        id: uuidv4(),
        userId: me.id,
        secret: secret("totp"),
        backupCodes: secret("backup-codes"),
      });

      const phoneSessionId = generateId();
      await db.insert(session).values({
        id: phoneSessionId,
        userId: me.id,
        token: secret("phone-session-token"),
        expiresAt: new Date("2036-01-01T00:00:00Z"),
        createdAt: new Date("2026-03-04T10:00:00Z"),
        updatedAt: new Date("2026-03-04T10:00:00Z"),
        userAgent: "FlexiDay/1.4 iPhone",
        deviceId: "device-ada-phone",
        platform: "ios",
        appVersion: "1.4.0",
      });
      await db.insert(pushRegistrations).values({
        sessionId: phoneSessionId,
        token: secret("apns"),
        environment: pushEnvironment.Production,
      });

      const connectionId = generateId();
      await db.insert(calendarConnection).values({
        id: connectionId,
        userId: me.id,
        provider: calendarProvider.Google,
        refreshTokenEnc: secret("calendar-refresh"),
        accessTokenEnc: secret("calendar-access"),
        grantedScopes: "https://www.googleapis.com/auth/calendar.events",
        capability: calendarCapability.Status,
      });
      await db.insert(calendarSync).values({
        id: generateId(),
        userId: me.id,
        name: "My leave",
        token: secret("feed"),
        connectionId,
      });

      await db.insert(userSettings).values({
        userId: me.id,
        emailNotifications: false,
        language: appLanguage.Czech,
      });
      await db.insert(userBirthdays).values({ userId: me.id, month: 4, day: 12, shared: true });
      await db.insert(notifications).values({
        id: generateId(),
        userId: me.id,
        type: notificationType.ApprovalDecided,
        title: "Request approved",
        body: "Your leave on 3 May was approved.",
        href: "/requests/",
      });

      const res = await request(server.url).get(ROUTE).set("Cookie", cookie).expect(200);
      raw = res.text;
      body = JSON.parse(raw) as Record<string, unknown>;
      disposition = res.headers["content-disposition"];
    });

    it("is served as a JSON attachment", () => {
      expect(disposition).toMatch(
        /^attachment; filename="flexi-day-account-\d{4}-\d{2}-\d{2}\.json"; filename\*=UTF-8''flexi-day-account-\d{4}-\d{2}-\d{2}\.json$/
      );
    });

    it("holds the profile, settings, birthday and notifications", () => {
      expect(body.account).toMatchObject({
        id: me.id,
        name: "Ada Export",
        email: `${me.id.toLowerCase()}@report-e2e.test`,
        image: "https://example.test/ada.png",
        twoFactorEnabled: true,
      });
      expect(body.settings).toMatchObject({ emailNotifications: false, language: "cs" });
      expect(body.birthday).toMatchObject({ month: 4, day: 12, year: null, shared: true });
      expect(body.notifications).toEqual([
        expect.objectContaining({
          type: "approval_decided",
          title: "Request approved",
          body: "Your leave on 3 May was approved.",
          href: "/requests/",
          readAt: null,
        }),
      ]);
    });

    it("lists linked providers with dates", () => {
      expect(body.signInMethods).toEqual(
        expect.arrayContaining([
          {
            providerId: "credential",
            accountId: me.id,
            createdAt: "2026-01-02T10:00:00.000Z",
            updatedAt: "2026-01-02T10:00:00.000Z",
          },
          {
            providerId: "google",
            accountId: "google-subject-123",
            createdAt: "2026-02-03T10:00:00.000Z",
            updatedAt: "2026-02-03T10:00:00.000Z",
          },
        ])
      );
    });

    it("lists sessions and devices, marking the one that asked", () => {
      const sessions = body.sessions as Record<string, unknown>[];
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s) => s.current)).toHaveLength(1);
      expect(sessions).toContainEqual(
        expect.objectContaining({
          current: false,
          deviceId: "device-ada-phone",
          platform: "ios",
          appVersion: "1.4.0",
          userAgent: "FlexiDay/1.4 iPhone",
          createdAt: "2026-03-04T10:00:00.000Z",
          expiresAt: "2036-01-01T00:00:00.000Z",
        })
      );
    });

    it("lists push registrations by device", () => {
      expect(body.pushRegistrations).toEqual([
        expect.objectContaining({
          environment: "production",
          deviceId: "device-ada-phone",
          platform: "ios",
        }),
      ]);
    });

    it("lists calendar connections and feeds with dates", () => {
      expect(body.calendarConnections).toEqual([
        expect.objectContaining({
          provider: "GOOGLE",
          status: "ACTIVE",
          capability: "STATUS",
          grantedScopes: "https://www.googleapis.com/auth/calendar.events",
          revokedAt: null,
        }),
      ]);
      expect(body.calendarFeeds).toEqual([
        expect.objectContaining({ name: "My leave", scope: "ME", syncsTo: "GOOGLE" }),
      ]);
    });

    it("carries no token, password hash or other secret", async () => {
      const [mySession] = await db
        .select({ token: session.token, id: session.id })
        .from(session)
        .where(eq(session.userId, me.id));
      const all = [...secrets, mySession!.token];

      expect(secrets).toHaveLength(11);
      for (const value of all) expect(raw).not.toContain(value);
      expect(raw).not.toMatch(/"(accessToken|refreshToken|idToken|password|secret|token)"/i);
      expect(raw).not.toMatch(/backupCodes|TokenEnc/);
    });
  });

  describe("on every plan", () => {
    const ownerOn = async (plan: subscriptionPlan | null) => {
      const owner = await makeUser(`Owner on ${plan ?? "FREE"}`);
      const organization = await ensureOrganizationForUser(owner.id);
      if (plan) {
        await upsertSubscription(organization.id, {
          plan,
          status: subscriptionStatus.Active,
          graceEndsAt: null,
        });
      }
      return owner;
    };

    it.each([
      ["Free", null],
      ["Pro", subscriptionPlan.Pro],
      ["Enterprise", subscriptionPlan.Enterprise],
    ] as const)("answers for an owner on %s", async (_label, plan) => {
      const owner = await ownerOn(plan);
      const res = await request(server.url)
        .get(ROUTE)
        .set("Cookie", await authCookieFor(owner.id))
        .expect(200);
      expect(res.body.account).toMatchObject({ id: owner.id, name: owner.name });
      expect(res.body.birthday).toBeNull();
      expect(res.body.notifications).toEqual([]);
    });
  });
});
