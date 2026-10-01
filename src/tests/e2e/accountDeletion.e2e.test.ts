import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { generateId } from "better-auth";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { account, session as sessionTable, user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { subscriptions, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { supportAccess } from "../../db/schema/support-access-schema.js";
import { changesSchema, changesType } from "../../db/schema/changes-schema.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { attendanceSessions } from "../../db/schema/attendance-schema.js";
import { organizationAttendanceSettings } from "../../db/schema/organization-attendance-settings-schema.js";
import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import { attachmentStore } from "../../services/attachment/attachmentStore.js";
import { incomingKey } from "../../services/attachment/s3Layout.js";
import {
  ensureOrganizationForUser,
  lockOrganization,
} from "../../services/organization/organizationServices.js";
import { deleteUser } from "../../services/user/userServices.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import {
  WEB_TEST_PASSWORD,
  authCookieFor,
  createTestSession,
  createAuthCookie,
  createWebUser,
  webSessionCookieFor,
} from "./helpers/authHelper.js";
import { cookieHeaderOf, nativeHeaders, sessionsOf } from "./helpers/nativeSessionHelpers.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const { mockUnmarshal } = vi.hoisted(() => ({ mockUnmarshal: vi.fn() }));

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

// Stands in for signature verification only; everything after it runs for real.
vi.mock("../../utils/paddle.js", () => ({
  requirePaddle: () => ({
    paddle: { webhooks: { unmarshal: mockUnmarshal } },
    paddleConfig: {
      apiKey: "key",
      webhookSecret: "whsec_test",
      environment: "sandbox",
      prices: {
        proMonthly: "pri_pro_m",
        proYearly: "pri_pro_y",
        enterpriseMonthly: "pri_ent_m",
        enterpriseYearly: "pri_ent_y",
        extraGroupMonthly: "pri_slot_m",
        extraGroupYearly: "pri_slot_y",
      },
    },
  }),
}));

const HOUR_MS = 60 * 60 * 1000;
const CURRENT_YEAR = new Date().getUTCFullYear();

describe("account deletion", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  const socialUser = async (name: string) => {
    const id = generateId();
    await db.insert(user).values({
      id,
      email: `social-${id.toLowerCase()}@deletion-e2e.test`,
      name,
      emailVerified: true,
    });
    await db.insert(account).values({
      id: uuidv4(),
      userId: id,
      providerId: "google",
      accountId: `google-${id}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id };
  };

  const organizationOf = async (ownerId: string) => (await ensureOrganizationForUser(ownerId)).id;

  const makeGroup = async (
    name: string,
    managerUserId: string,
    organizationId: string,
    approvers: { main?: string; temp?: string } = {}
  ) => {
    const id = uuidv4();
    await db.insert(groups).values({
      id,
      organizationId,
      groupName: name,
      managerUserId,
      mainApprovalUser: approvers.main ?? null,
      tempApprovalUser: approvers.temp ?? null,
    });
    return id;
  };

  const addMember = async (groupId: string, userId: string, viewAccess = false) => {
    await db.insert(groupUsers).values({ id: uuidv4(), groupId, userId, viewAccess });
  };

  const employ = async (organizationId: string, userId: string, endedAt: Date | null = null) => {
    const id = uuidv4();
    await db.insert(employments).values({ id, organizationId, userId, endedAt });
    return id;
  };

  const subscribe = async (
    organizationId: string,
    state: { status: subscriptionStatus; cancelAt?: Date | null }
  ) => {
    const paddleSubscriptionId = `psub_${uuidv4()}`;
    await db.insert(subscriptions).values({
      id: uuidv4(),
      organizationId,
      paddleSubscriptionId,
      status: state.status,
      cancelAt: state.cancelAt ?? null,
    });
    return paddleSubscriptionId;
  };

  const status = async (userId: string) =>
    request(server.url)
      .get("/api/users/me/deletion")
      .set("Cookie", await authCookieFor(userId));

  const deleteWith = async (cookie: string, body: Record<string, unknown> = {}) =>
    request(server.url).post("/api/users/me/delete").set("Cookie", cookie).send(body);

  const userExists = async (userId: string) =>
    (await db.select({ id: user.id }).from(user).where(eq(user.id, userId))).length === 1;

  const errorContext = (res: request.Response) =>
    (res.body as { errors: { context?: Record<string, unknown> }[] }).errors[0]?.context;

  describe("status", () => {
    it("tells a password user they can delete with their password", async () => {
      const { id } = await createWebUser("Status Password");

      const res = await status(id);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ canDelete: true, blockers: [], confirmation: "password" });
    });

    it("asks a social-only user for a recent sign-in", async () => {
      const { id } = await socialUser("Status Social");

      const res = await status(id);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ canDelete: true, blockers: [], confirmation: "recent-sign-in" });
    });

    it("answers 401 without a session", async () => {
      await request(server.url).get("/api/users/me/deletion").expect(401);
    });
  });

  describe("confirmation", () => {
    it("deletes a password user and ends both their web and phone sessions", async () => {
      const { id, email } = await createWebUser("Delete Me");
      const webCookie = await webSessionCookieFor(server.url, email);
      const device = `device-${uuidv4()}`;
      const nativeSignIn = await request(server.url)
        .post("/api/auth/sign-in/email")
        .set(nativeHeaders(device))
        .send({ email, password: WEB_TEST_PASSWORD })
        .expect(200);
      const nativeCookie = cookieHeaderOf(nativeSignIn);
      expect(await sessionsOf(id)).toHaveLength(2);

      const res = await deleteWith(webCookie, { password: WEB_TEST_PASSWORD });

      expect(res.status).toBe(204);
      const cleared = ((res.headers["set-cookie"] as unknown as string[]) ?? []).find((entry) =>
        entry.startsWith("better-auth.session_token=;")
      );
      expect(cleared).toMatch(/expires=Thu, 01 Jan 1970/i);
      expect(await userExists(id)).toBe(false);
      expect(await sessionsOf(id)).toHaveLength(0);

      await request(server.url).get("/api/users/me/settings").set("Cookie", webCookie).expect(401);
      await request(server.url)
        .get("/api/users/me/settings")
        .set(nativeHeaders(device))
        .set("Cookie", nativeCookie)
        .expect(401);
    });

    it("refuses a wrong or missing password and leaves every row in place", async () => {
      const { id } = await createWebUser("Wrong Password");
      const organizationId = await organizationOf(id);
      const groupId = await makeGroup("Kept Group", id, organizationId);
      const cookie = await authCookieFor(id);

      for (const body of [{ password: "not-the-password" }, {}]) {
        const res = await deleteWith(cookie, body);
        expect(res.status).toBe(403);
        expect(errorContext(res)).toEqual({ reason: "PASSWORD_INVALID" });
      }

      expect(await userExists(id)).toBe(true);
      expect(await sessionsOf(id)).toHaveLength(1);
      expect(await db.select().from(account).where(eq(account.userId, id))).toHaveLength(1);
      expect(
        await db.select().from(organizations).where(eq(organizations.id, organizationId))
      ).toHaveLength(1);
      expect(await db.select().from(groups).where(eq(groups.id, groupId))).toHaveLength(1);
    });

    it("sends a social-only user with an old session to sign in again", async () => {
      const { id } = await socialUser("Stale Social");
      const token = await createTestSession(id);
      await db
        .update(sessionTable)
        .set({ createdAt: new Date(Date.now() - 25 * HOUR_MS) })
        .where(eq(sessionTable.token, token));

      const res = await deleteWith(createAuthCookie(token));

      expect(res.status).toBe(403);
      expect(errorContext(res)).toEqual({ reason: "REAUTH_REQUIRED" });
      expect(await userExists(id)).toBe(true);
    });

    it("deletes a social-only user with a session under a day old, without a password", async () => {
      const { id } = await socialUser("Fresh Social");
      const token = await createTestSession(id);
      await db
        .update(sessionTable)
        .set({ createdAt: new Date(Date.now() - 23 * HOUR_MS) })
        .where(eq(sessionTable.token, token));

      const res = await deleteWith(createAuthCookie(token));

      expect(res.status).toBe(204);
      expect(await userExists(id)).toBe(false);
    });
  });

  describe("blockers", () => {
    it("refuses a manager whose group has another live member, naming the group", async () => {
      const { id } = await createWebUser("Busy Manager");
      const other = await createWebUser("Team Member");
      const organizationId = await organizationOf(id);
      const groupId = await makeGroup("Busy Team", id, organizationId);
      await addMember(groupId, id);
      await addMember(groupId, other.id);

      const res = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });

      expect(res.status).toBe(409);
      expect(errorContext(res)).toEqual({
        reason: "DELETION_BLOCKED",
        blockers: [{ kind: "GROUP_HAS_MEMBERS", groupId, groupName: "Busy Team", otherMembers: 1 }],
      });
      expect(await userExists(id)).toBe(true);
      expect(await db.select().from(groups).where(eq(groups.id, groupId))).toHaveLength(1);
    });

    it("sees a member who joins while the delete waits on the organization", async () => {
      const { id } = await createWebUser("Racing Manager");
      const joiner = await createWebUser("Racing Joiner");
      const organizationId = await organizationOf(id);
      const groupId = await makeGroup("Racing Team", id, organizationId);
      const cookie = await authCookieFor(id);

      let pending: Promise<request.Response> | undefined;
      await db.transaction(async (tx) => {
        await lockOrganization(organizationId, tx);
        await tx.insert(groupUsers).values({ id: uuidv4(), groupId, userId: joiner.id });
        pending = deleteWith(cookie, { password: WEB_TEST_PASSWORD });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      });
      const res = await pending!;

      expect(res.status).toBe(409);
      expect(errorContext(res)?.blockers).toEqual([
        { kind: "GROUP_HAS_MEMBERS", groupId, groupName: "Racing Team", otherMembers: 1 },
      ]);
      expect(await userExists(id)).toBe(true);
    });

    it("ignores members who have left the group", async () => {
      const { id } = await createWebUser("Lonely Manager");
      const former = await createWebUser("Former Member");
      const organizationId = await organizationOf(id);
      const groupId = await makeGroup("Emptied Team", id, organizationId);
      await db
        .insert(groupUsers)
        .values({ id: uuidv4(), groupId, userId: former.id, deletedAt: new Date() });

      const res = await status(id);

      expect(res.body).toMatchObject({ canDelete: true, blockers: [] });
    });

    it("refuses an owner while another user has an open Employment", async () => {
      const { id } = await createWebUser("Busy Owner");
      const delegate = await createWebUser("Delegate");
      const organizationId = await organizationOf(id);
      await employ(organizationId, delegate.id);
      const [organization] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, organizationId));

      const res = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });

      expect(res.status).toBe(409);
      expect(errorContext(res)?.blockers).toEqual([
        {
          kind: "ORGANIZATION_HAS_MEMBERS",
          organizationId,
          organizationName: organization!.name,
          otherMembers: 1,
        },
      ]);
      expect(await userExists(id)).toBe(true);
    });

    it("refuses an owner whose subscription will renew, and lets them go once it will not", async () => {
      const { id } = await createWebUser("Paying Owner");
      const organizationId = await organizationOf(id);
      await subscribe(organizationId, { status: subscriptionStatus.Active });
      const cookie = await authCookieFor(id);

      const refused = await deleteWith(cookie, { password: WEB_TEST_PASSWORD });

      expect(refused.status).toBe(409);
      expect(errorContext(refused)?.blockers).toEqual([
        expect.objectContaining({ kind: "SUBSCRIPTION_RENEWING", organizationId }),
      ]);

      await db
        .update(subscriptions)
        .set({ cancelAt: new Date(Date.now() + 10 * 24 * HOUR_MS) })
        .where(eq(subscriptions.organizationId, organizationId));

      const deleted = await deleteWith(cookie, { password: WEB_TEST_PASSWORD });

      expect(deleted.status).toBe(204);
      expect(
        await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.organizationId, organizationId))
      ).toHaveLength(0);
    });

    it("lets an owner with a canceled subscription go", async () => {
      const { id } = await createWebUser("Lapsed Owner");
      const organizationId = await organizationOf(id);
      await subscribe(organizationId, { status: subscriptionStatus.Canceled });

      const res = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });

      expect(res.status).toBe(204);
      expect(
        await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.organizationId, organizationId))
      ).toHaveLength(0);
    });

    it("refuses a configured support admin and keeps their access trail", async () => {
      const { id } = await createWebUser("Support Staff");
      await db
        .insert(supportAccess)
        .values({ id: uuidv4(), userId: id, method: "GET", path: "/api/support/organizations" });
      const original = config.support;
      config.support = { userIds: [id] };
      try {
        const res = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });

        expect(res.status).toBe(409);
        expect(errorContext(res)?.blockers).toEqual([{ kind: "SUPPORT_ADMIN" }]);
      } finally {
        config.support = original;
      }
      expect(
        await db.select().from(supportAccess).where(eq(supportAccess.userId, id))
      ).toHaveLength(1);
    });

    it("refuses a former support admin whose access trail is still there", async () => {
      const { id } = await createWebUser("Former Support Staff");
      await db
        .insert(supportAccess)
        .values({ id: uuidv4(), userId: id, method: "GET", path: "/api/support/groups/x" });

      const res = await status(id);

      expect(res.body).toMatchObject({ canDelete: false, blockers: [{ kind: "SUPPORT_ADMIN" }] });
    });

    it("lists every blocker that applies, in the status and in the refusal", async () => {
      const { id } = await createWebUser("Everything Owner");
      const member = await createWebUser("Everything Member");
      const organizationId = await organizationOf(id);
      const groupId = await makeGroup("Everything Team", id, organizationId);
      await addMember(groupId, member.id);
      await employ(organizationId, member.id);
      await subscribe(organizationId, { status: subscriptionStatus.PastDue });
      const original = config.support;
      config.support = { userIds: [id] };
      try {
        const kinds = [
          "GROUP_HAS_MEMBERS",
          "ORGANIZATION_HAS_MEMBERS",
          "SUBSCRIPTION_RENEWING",
          "SUPPORT_ADMIN",
        ];

        const listed = await status(id);
        expect(listed.body.canDelete).toBe(false);
        expect(listed.body.blockers.map((b: { kind: string }) => b.kind)).toEqual(kinds);

        const refused = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });
        expect(refused.status).toBe(409);
        expect(errorContext(refused)?.blockers).toEqual(listed.body.blockers);
      } finally {
        config.support = original;
      }
      expect(await userExists(id)).toBe(true);
    });
  });

  describe("what goes and what stays", () => {
    it("takes a solo owner's organization with everything in it, all or nothing", async () => {
      const { id } = await createWebUser("Solo Owner");
      const former = await createWebUser("Former Employee");
      const outsider = await createWebUser("Outside Manager");
      const organizationId = await organizationOf(id);
      const outsideOrganizationId = await organizationOf(outsider.id);
      const groupId = await makeGroup("Solo Team", id, organizationId);
      const closedGroupId = await makeGroup("Closed Team", id, organizationId);
      await db.update(groups).set({ deletedAt: new Date() }).where(eq(groups.id, closedGroupId));
      await addMember(groupId, id);
      await db.insert(vacation).values({
        id: uuidv4(),
        userId: id,
        groupId,
        requestId: uuidv4(),
        requestedDay: `${CURRENT_YEAR.toString()}-06-01`,
      });
      await subscribe(organizationId, {
        status: subscriptionStatus.Active,
        cancelAt: new Date(Date.now() + 24 * HOUR_MS),
      });
      await db.insert(organizationAttendanceSettings).values({ organizationId });
      const formerEmploymentId = await employ(organizationId, former.id, new Date());
      await db.insert(attendanceSessions).values({
        id: uuidv4(),
        employmentId: formerEmploymentId,
        businessDate: `${CURRENT_YEAR.toString()}-01-05`,
        startedAt: new Date(`${CURRENT_YEAR.toString()}-01-05T08:00:00Z`),
        endedAt: new Date(`${CURRENT_YEAR.toString()}-01-05T16:00:00Z`),
        timezone: "Europe/Prague",
      });
      const outsideGroupId = await makeGroup("Outside Team", outsider.id, outsideOrganizationId, {
        main: id,
      });
      const changeId = uuidv4();
      await db.insert(changesSchema).values({
        id: changeId,
        userId: outsider.id,
        groupId: outsideGroupId,
        changeType: changesType.UserYearQuotas,
        changeDetail: "Quota changed",
        changingUserId: id,
      });

      const countRows = async () => ({
        organizations: (
          await db.select().from(organizations).where(eq(organizations.id, organizationId))
        ).length,
        groups: (
          await db
            .select()
            .from(groups)
            .where(inArray(groups.id, [groupId, closedGroupId]))
        ).length,
        subscriptions: (
          await db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.organizationId, organizationId))
        ).length,
        attendanceSettings: (
          await db
            .select()
            .from(organizationAttendanceSettings)
            .where(eq(organizationAttendanceSettings.organizationId, organizationId))
        ).length,
        formerEmployments: (
          await db.select().from(employments).where(eq(employments.id, formerEmploymentId))
        ).length,
        attendanceSessions: (
          await db
            .select()
            .from(attendanceSessions)
            .where(eq(attendanceSessions.employmentId, formerEmploymentId))
        ).length,
        vacations: (await db.select().from(vacation).where(eq(vacation.userId, id))).length,
      });
      const before = await countRows();
      expect(Object.values(before).every((n) => n > 0)).toBe(true);

      // The user row is the last delete, so failing it proves everything
      // before it rolls back.
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION account_deletion_e2e_fail() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql`);
      await db.execute(
        sql.raw(`CREATE TRIGGER account_deletion_e2e_fail BEFORE DELETE ON "user"
          FOR EACH ROW WHEN (OLD.id = '${id}') EXECUTE FUNCTION account_deletion_e2e_fail()`)
      );
      const cookie = await authCookieFor(id);
      try {
        const failed = await deleteWith(cookie, { password: WEB_TEST_PASSWORD });
        expect(failed.status).toBe(500);
      } finally {
        await db.execute(sql`DROP TRIGGER account_deletion_e2e_fail ON "user"`);
        await db.execute(sql`DROP FUNCTION account_deletion_e2e_fail()`);
      }

      expect(await userExists(id)).toBe(true);
      expect(await countRows()).toEqual(before);
      const [untouchedChange] = await db
        .select()
        .from(changesSchema)
        .where(eq(changesSchema.id, changeId));
      expect(untouchedChange).toMatchObject({ changingUserId: id, changingUserDeleted: false });
      const [untouchedGroup] = await db.select().from(groups).where(eq(groups.id, outsideGroupId));
      expect(untouchedGroup?.mainApprovalUser).toBe(id);

      const deleted = await deleteWith(cookie, { password: WEB_TEST_PASSWORD });

      expect(deleted.status).toBe(204);
      expect(await userExists(id)).toBe(false);
      expect(await countRows()).toEqual({
        organizations: 0,
        groups: 0,
        subscriptions: 0,
        attendanceSettings: 0,
        formerEmployments: 0,
        attendanceSessions: 0,
        vacations: 0,
      });
      expect(await userExists(former.id)).toBe(true);
    });

    it("clears the approver slots the user held in someone else's group and nothing else", async () => {
      const { id } = await createWebUser("Departing Approver");
      const manager = await createWebUser("Staying Manager");
      const deputy = await createWebUser("Staying Deputy");
      const organizationId = await organizationOf(manager.id);
      const mainGroupId = await makeGroup("Main Slot Team", manager.id, organizationId, {
        main: id,
        temp: deputy.id,
      });
      const tempGroupId = await makeGroup("Temp Slot Team", manager.id, organizationId, {
        main: manager.id,
        temp: id,
      });
      await addMember(mainGroupId, id);

      const res = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });

      expect(res.status).toBe(204);
      const [mainGroup] = await db.select().from(groups).where(eq(groups.id, mainGroupId));
      expect(mainGroup).toMatchObject({
        groupName: "Main Slot Team",
        managerUserId: manager.id,
        mainApprovalUser: null,
        tempApprovalUser: deputy.id,
        deletedAt: null,
      });
      const [tempGroup] = await db.select().from(groups).where(eq(groups.id, tempGroupId));
      expect(tempGroup).toMatchObject({
        groupName: "Temp Slot Team",
        mainApprovalUser: manager.id,
        tempApprovalUser: null,
        deletedAt: null,
      });
    });

    it("keeps the quota changes the user made, marked as made by a deleted user", async () => {
      const { id } = await createWebUser("Departing Admin");
      const manager = await createWebUser("Report Manager");
      const member = await createWebUser("Report Member");
      const organizationId = await organizationOf(manager.id);
      const groupId = await makeGroup("Report Team", manager.id, organizationId);
      await addMember(groupId, manager.id, true);
      await addMember(groupId, member.id);
      const byAdmin = uuidv4();
      const byRollover = uuidv4();
      await db.insert(changesSchema).values([
        {
          id: byAdmin,
          userId: member.id,
          groupId,
          changeType: changesType.UserYearQuotas,
          changeDetail: "Quota: vacation 20 → 22",
          changingUserId: id,
          createdAt: new Date(Date.now() - 2000),
        },
        {
          id: byRollover,
          userId: member.id,
          groupId,
          changeType: changesType.UserYearQuotas,
          changeDetail: "Rollover: carried over 3",
          changingUserId: null,
          createdAt: new Date(Date.now() - 1000),
        },
      ]);

      const res = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });
      expect(res.status).toBe(204);

      const [kept] = await db.select().from(changesSchema).where(eq(changesSchema.id, byAdmin));
      expect(kept).toMatchObject({ changingUserId: null, changingUserDeleted: true });

      const report = await request(server.url)
        .get(`/api/reports/members/${member.id}`)
        .query({ year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);
      const entries = report.body.changes as {
        id: string;
        actor: unknown;
        actorDeleted: boolean;
      }[];
      expect(entries.find((entry) => entry.id === byAdmin)).toMatchObject({
        actor: null,
        actorDeleted: true,
      });
      expect(entries.find((entry) => entry.id === byRollover)).toMatchObject({
        actor: null,
        actorDeleted: false,
      });
    });

    it("removes the stored objects of every attachment the deletion takes, after the commit", async () => {
      const { id } = await createWebUser("Attachment Owner");
      const employee = await createWebUser("Former Uploader");
      const outsider = await createWebUser("Outside Owner");
      const organizationId = await organizationOf(id);
      const outsideOrganizationId = await organizationOf(outsider.id);
      const attachment = (
        ownerUserId: string,
        orgId: string,
        state: AttachmentStatus = AttachmentStatus.Ready
      ) => ({
        id: uuidv4(),
        requestId: uuidv4(),
        organizationId: orgId,
        ownerUserId,
        fileName: "note.pdf",
        contentType: "application/pdf",
        size: 100,
        storageKey: `attachments/${uuidv4()}`,
        status: state,
      });
      const own = attachment(id, outsideOrganizationId);
      const inOwnedOrganization = attachment(
        employee.id,
        organizationId,
        AttachmentStatus.Uploading
      );
      const unrelated = attachment(outsider.id, outsideOrganizationId);
      await db.insert(attachments).values([own, inOwnedOrganization, unrelated]);
      const userGoneAtEachCall: boolean[] = [];
      const deleteObject = vi
        .spyOn(attachmentStore, "deleteObject")
        .mockImplementation(async () => {
          userGoneAtEachCall.push(!(await userExists(id)));
        });

      const res = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });

      expect(res.status).toBe(204);
      const keys = deleteObject.mock.calls.map(([key]) => key);
      expect(keys).toContain(own.storageKey);
      expect(keys).toContain(inOwnedOrganization.storageKey);
      expect(keys).toContain(incomingKey(inOwnedOrganization.id));
      expect(keys).not.toContain(unrelated.storageKey);
      expect(userGoneAtEachCall.length).toBeGreaterThan(0);
      expect(userGoneAtEachCall.every(Boolean)).toBe(true);
      const left = await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(inArray(attachments.id, [own.id, inOwnedOrganization.id, unrelated.id]));
      expect(left).toEqual([{ id: unrelated.id }]);
    });

    it("answers 204 when the object store refuses, and logs it", async () => {
      const { id } = await createWebUser("Unlucky Owner");
      const organizationId = await organizationOf(id);
      await db.insert(attachments).values({
        id: uuidv4(),
        requestId: uuidv4(),
        organizationId,
        ownerUserId: id,
        fileName: "scan.jpg",
        contentType: "image/jpeg",
        size: 100,
        storageKey: `attachments/${uuidv4()}`,
        status: AttachmentStatus.Ready,
      });
      vi.spyOn(attachmentStore, "deleteObject").mockRejectedValue(new Error("store down"));
      const logError = vi.spyOn(logger, "error");

      const res = await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD });

      expect(res.status).toBe(204);
      expect(await userExists(id)).toBe(false);
      expect(logError).toHaveBeenCalledWith(
        "Account deletion could not remove an attachment object",
        expect.objectContaining({ userId: id, error: "store down" })
      );
    });

    it("leaves the failed invite sign-up cleanup able to remove a fresh account", async () => {
      const { id } = await createWebUser("Abandoned Sign Up");
      await db.update(user).set({ emailVerified: false }).where(eq(user.id, id));
      await createTestSession(id);

      await deleteUser(id);

      expect(await userExists(id)).toBe(false);
      expect(await sessionsOf(id)).toHaveLength(0);
      expect(await db.select().from(account).where(eq(account.userId, id))).toHaveLength(0);
    });

    it("acknowledges a later Paddle event for the deleted organization and changes nothing", async () => {
      const { id } = await createWebUser("Departed Customer");
      const organizationId = await organizationOf(id);
      const paddleSubscriptionId = await subscribe(organizationId, {
        status: subscriptionStatus.Canceled,
      });
      await deleteWith(await authCookieFor(id), { password: WEB_TEST_PASSWORD }).then((res) =>
        expect(res.status).toBe(204)
      );

      for (const eventType of ["subscription.updated", "subscription.canceled"]) {
        mockUnmarshal.mockResolvedValueOnce({
          eventId: `evt_${uuidv4()}`,
          eventType,
          occurredAt: new Date().toISOString(),
          data: {
            id: paddleSubscriptionId,
            status: "canceled",
            customerId: "ctm_1",
            customData: { organizationId },
            items: [{ price: { id: "pri_pro_m" }, quantity: 1 }],
            currentBillingPeriod: null,
            scheduledChange: null,
          },
        });

        await request(server.url)
          .post("/api/webhooks/paddle")
          .set("Content-Type", "application/json")
          .set("paddle-signature", "ts=1;h1=abc")
          .send("{}")
          .expect(200);
      }

      expect(
        await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId))
      ).toHaveLength(0);
      expect(
        await db.select().from(organizations).where(eq(organizations.id, organizationId))
      ).toHaveLength(0);
    });
  });
});
