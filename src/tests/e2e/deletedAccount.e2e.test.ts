import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { account, session as sessionTable, user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { vacationEvents, vacationEventType } from "../../db/schema/vacation-event-schema.js";
import {
  attendanceClosedBy,
  attendanceEvents,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { userSettings } from "../../db/schema/user-settings-schema.js";
import { userBirthdays } from "../../db/schema/user-birthday-schema.js";
import { calendarSync } from "../../db/schema/calendar-sync-schema.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { hashPassword } from "better-auth/crypto";
import {
  WEB_TEST_PASSWORD,
  authCookieFor,
  createWebUser,
  webSessionCookieFor,
} from "./helpers/authHelper.js";
import {
  addChange,
  addLeave,
  addQuota,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

type SentEmail = { to: string; template: string; data: Record<string, string> };
const sentEmails: SentEmail[] = [];
vi.mock("../../services/email/index.js", () => ({
  emailSender: {
    sendTemplated: (email: SentEmail) => {
      sentEmails.push(email);
      return Promise.resolve();
    },
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE = "Europe/Prague";
const MEMBER = "Jana Nováková";
const OWNER = "Olga Owner";

/** The first weekday at least `days` days from now, as an ISO date. */
const weekdayFromNow = (days: number): string => {
  const date = new Date(Date.now() + days * DAY_MS);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + (days < 0 ? -1 : 1));
  }
  return date.toISOString().slice(0, 10);
};

const PAST_DAY = weekdayFromNow(-14);
const FUTURE_DAY = weekdayFromNow(21);
const PENDING_DAY = weekdayFromNow(28);
const YEAR = Number(FUTURE_DAY.slice(0, 4));

describe("a deleted account", () => {
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
  });

  /**
   * An organization owned by Olga with one group, where Jana is a member with
   * every flag, the temp approver, a delegated org admin and employed, with
   * bookings in every state, a quota, change log entries and a running clock.
   */
  const setUp = async () => {
    const owner = await makeUser(OWNER);
    const member = await createWebUser(MEMBER);
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const groupId = uuidv4();
    await db.insert(groups).values({
      id: groupId,
      organizationId,
      groupName: "Acme Team",
      managerUserId: owner.id,
      tempApprovalUser: member.id,
    });
    await db.insert(groupUsers).values([
      {
        id: uuidv4(),
        groupId,
        userId: owner.id,
        viewAccess: true,
        adminAccess: true,
        approverAccess: true,
        controlledUser: true,
      },
      {
        id: uuidv4(),
        groupId,
        userId: member.id,
        viewAccess: true,
        adminAccess: true,
        approverAccess: true,
        controlledUser: true,
      },
    ]);
    await db.insert(organizationUsers).values({
      id: uuidv4(),
      organizationId,
      userId: member.id,
      grantedByUserId: owner.id,
    });
    await syncEmployment(organizationId, owner.id);
    await syncEmployment(organizationId, member.id);
    await db
      .update(employments)
      .set({ startedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(employments.organizationId, organizationId));

    await addQuota(groupId, member.id, YEAR);
    await addChange(groupId, member.id, owner.id, "Quota for Jana: 20 → 22");
    await addChange(groupId, owner.id, member.id, "Quota for Olga: 20 → 25");
    const pastId = await addLeave(groupId, member.id, PAST_DAY, { approvedBy: owner.id });
    const futureId = await addLeave(groupId, member.id, FUTURE_DAY, { approvedBy: owner.id });
    const requestId = uuidv4();
    const pendingId = await addLeave(groupId, member.id, PENDING_DAY, {
      approved: false,
      requestId,
    });

    await upsertAttendanceSettings(organizationId, { timezone: ZONE });
    const [employment] = await db
      .select()
      .from(employments)
      .where(
        and(eq(employments.organizationId, organizationId), eq(employments.userId, member.id))
      );
    const sessionId = uuidv4();
    await db.insert(attendanceSessions).values({
      id: sessionId,
      employmentId: employment!.id,
      businessDate: new Date().toISOString().slice(0, 10),
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      timezone: ZONE,
    });

    await db.insert(userSettings).values({ userId: member.id });
    await db.insert(userBirthdays).values({ userId: member.id, month: 3, day: 14, shared: true });
    await db.insert(notifications).values({
      id: uuidv4(),
      userId: member.id,
      type: notificationType.Comment,
      title: "A comment",
      body: "On your request",
      href: "/requests/",
    });
    await db.insert(calendarSync).values({
      id: uuidv4(),
      userId: member.id,
      name: "Jana's feed",
      token: `flx_live_${uuidv4().replace(/-/g, "")}`,
    });

    return {
      owner,
      member,
      organizationId,
      groupId,
      employmentId: employment!.id,
      sessionId,
      pastId,
      futureId,
      pendingId,
    };
  };

  const deleteAccount = async (email: string) => {
    const cookie = await webSessionCookieFor(server.url, email);
    return request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", cookie)
      .send({ password: WEB_TEST_PASSWORD });
  };

  describe("the employer's records", () => {
    it("keeps bookings, quotas, attendance and the change log, and leaves the Employment open", async () => {
      const world = await setUp();
      const before = Date.now();

      const res = await deleteAccount(world.member.email);
      expect(res.status).toBe(204);

      const rows = await db.select().from(vacation).where(eq(vacation.userId, world.member.id));
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(world.pastId)).toMatchObject({ deletedAt: null, approvedBy: world.owner.id });
      expect(byId.get(world.futureId)).toMatchObject({ deletedAt: null });
      expect(byId.get(world.pendingId)?.deletedAt).not.toBeNull();
      expect(byId.get(world.pendingId)?.deletedByUserId).toBeNull();

      const cancelled = await db
        .select()
        .from(vacationEvents)
        .where(eq(vacationEvents.vacationId, world.pendingId));
      expect(cancelled).toEqual([
        expect.objectContaining({
          eventType: vacationEventType.Cancelled,
          actorUserId: null,
          reason: "account deleted",
        }),
      ]);

      expect(
        await db.select().from(userYearQuotas).where(eq(userYearQuotas.userId, world.member.id))
      ).toHaveLength(1);
      const changes = await db
        .select()
        .from(changesSchema)
        .where(eq(changesSchema.groupId, world.groupId));
      expect(changes).toHaveLength(2);
      expect(changes.find((row) => row.userId === world.owner.id)).toMatchObject({
        changingUserId: world.member.id,
        changingUserDeleted: false,
      });

      const [employment] = await db
        .select()
        .from(employments)
        .where(eq(employments.id, world.employmentId));
      expect(employment).toMatchObject({ endedAt: null, name: MEMBER, email: world.member.email });
      expect(employment!.accountDeletedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

      const [membership] = await db
        .select()
        .from(groupUsers)
        .where(and(eq(groupUsers.groupId, world.groupId), eq(groupUsers.userId, world.member.id)));
      expect(membership).toMatchObject({
        deletedAt: null,
        viewAccess: false,
        adminAccess: false,
        approverAccess: false,
        controlledUser: true,
      });
      const [grant] = await db
        .select()
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, world.member.id));
      expect(grant?.deletedAt).not.toBeNull();
      const [group] = await db.select().from(groups).where(eq(groups.id, world.groupId));
      expect(group?.tempApprovalUser).toBeNull();

      const [closed] = await db
        .select()
        .from(attendanceSessions)
        .where(eq(attendanceSessions.id, world.sessionId));
      expect(closed?.closedBy).toBe(attendanceClosedBy.Sweep);
      expect(closed!.endedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      const sessionEvents = await db
        .select()
        .from(attendanceEvents)
        .where(eq(attendanceEvents.sessionId, world.sessionId));
      expect(sessionEvents).toContainEqual(expect.objectContaining({ changedByUserId: null }));

      expect(sentEmails).toEqual([]);
      const ownerNotices = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, world.owner.id));
      expect(ownerNotices).toEqual([]);
    });

    it("lets an owner go whose only remaining people are deleted accounts", async () => {
      const owner = await createWebUser("Solo Owner");
      const admin = await createWebUser("Delegated Admin");
      const organizationId = (await ensureOrganizationForUser(owner.id)).id;
      await db.insert(organizationUsers).values({
        id: uuidv4(),
        organizationId,
        userId: admin.id,
        grantedByUserId: owner.id,
      });
      await syncEmployment(organizationId, admin.id);

      expect((await deleteAccount(admin.email)).status).toBe(204);
      const [kept] = await db.select().from(employments).where(eq(employments.userId, admin.id));
      expect(kept).toMatchObject({ endedAt: null });

      const status = await request(server.url)
        .get("/api/users/me/deletion")
        .set("Cookie", await authCookieFor(owner.id))
        .expect(200);
      expect(status.body).toMatchObject({ canDelete: true, blockers: [] });
    });
  });

  describe("the stripped row", () => {
    it("keeps only the id, and nobody can sign in as it", async () => {
      const world = await setUp();
      const [before] = await db.select().from(user).where(eq(user.id, world.member.id));

      expect((await deleteAccount(world.member.email)).status).toBe(204);

      const [stripped] = await db.select().from(user).where(eq(user.id, world.member.id));
      expect(stripped).toMatchObject({
        name: "",
        email: `${world.member.id}@deleted.invalid`,
        image: null,
        emailVerified: false,
      });
      expect(stripped?.deletedAt).not.toBeNull();
      expect(stripped!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());

      expect(
        await db.select().from(sessionTable).where(eq(sessionTable.userId, world.member.id))
      ).toEqual([]);
      expect(await db.select().from(account).where(eq(account.userId, world.member.id))).toEqual(
        []
      );
      expect(
        await db.select().from(userSettings).where(eq(userSettings.userId, world.member.id))
      ).toEqual([]);
      expect(
        await db.select().from(notifications).where(eq(notifications.userId, world.member.id))
      ).toEqual([]);
      expect(
        await db.select().from(calendarSync).where(eq(calendarSync.userId, world.member.id))
      ).toEqual([]);
      const [birthday] = await db
        .select()
        .from(userBirthdays)
        .where(eq(userBirthdays.userId, world.member.id));
      expect(birthday).toMatchObject({ month: null, day: null, shared: false });
      expect(birthday?.deletedAt).not.toBeNull();

      await request(server.url)
        .post("/api/auth/sign-in/email")
        .send({ email: world.member.email, password: WEB_TEST_PASSWORD })
        .expect(401);

      // An address and a credential planted on the row by hand still open no session.
      const planted = `planted-${world.member.id.toLowerCase()}@report-e2e.test`;
      await db
        .update(user)
        .set({ email: planted, emailVerified: true })
        .where(eq(user.id, world.member.id));
      await db.insert(account).values({
        id: uuidv4(),
        userId: world.member.id,
        providerId: "credential",
        accountId: world.member.id,
        password: await hashPassword(WEB_TEST_PASSWORD),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const refused = await request(server.url)
        .post("/api/auth/sign-in/email")
        .send({ email: planted, password: WEB_TEST_PASSWORD });
      expect(refused.status).toBe(401);
      expect(
        await db.select().from(sessionTable).where(eq(sessionTable.userId, world.member.id))
      ).toEqual([]);
    });
  });

  describe("after the deletion", () => {
    it("refuses a booking made on the person's behalf", async () => {
      const world = await setUp();
      expect((await deleteAccount(world.member.email)).status).toBe(204);

      const res = await request(server.url)
        .post("/api/vacation/create-vacation")
        .set("Cookie", await authCookieFor(world.owner.id))
        .send({
          groupId: world.groupId,
          from: weekdayFromNow(35),
          to: weekdayFromNow(35),
          userId: world.member.id,
        });

      expect(res.status).toBe(403);
      expect(
        await db
          .select()
          .from(vacation)
          .where(
            and(eq(vacation.userId, world.member.id), eq(vacation.requestedDay, weekdayFromNow(35)))
          )
      ).toEqual([]);
    });

    it("offers the person as no org admin candidate and refuses the grant", async () => {
      const world = await setUp();
      expect((await deleteAccount(world.member.email)).status).toBe(204);
      const ownerCookie = await authCookieFor(world.owner.id);

      const candidates = await request(server.url)
        .get("/api/organization/candidates")
        .query({ organizationId: world.organizationId })
        .set("Cookie", ownerCookie)
        .expect(200);
      expect(
        (candidates.body as { userId: string }[]).map((candidate) => candidate.userId)
      ).not.toContain(world.member.id);

      await request(server.url)
        .post("/api/organization/admins")
        .query({ organizationId: world.organizationId })
        .set("Cookie", ownerCookie)
        .send({ userId: world.member.id })
        .expect(422);
    });

    it("sends the person no notice when their booking is cancelled", async () => {
      const world = await setUp();
      expect((await deleteAccount(world.member.email)).status).toBe(204);

      await request(server.url)
        .delete(`/api/vacation/${world.futureId}`)
        .set("Cookie", await authCookieFor(world.owner.id))
        .send({ reason: "Left the company" })
        .expect(200);

      expect(
        await db.select().from(notifications).where(eq(notifications.userId, world.member.id))
      ).toEqual([]);
      expect(sentEmails.filter((email) => email.to.endsWith("@deleted.invalid"))).toEqual([]);
      expect(sentEmails.filter((email) => email.to === world.member.email)).toEqual([]);
    });

    it("owes no time from the business date after the deletion, and labels the row", async () => {
      const world = await setUp();
      expect((await deleteAccount(world.member.email)).status).toBe(204);

      // A Monday-to-Sunday week in the past, with the deletion on its Wednesday.
      const monday = new Date(Date.now() - 21 * DAY_MS);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const dayOf = (offset: number) =>
        new Date(monday.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
      await db
        .update(employments)
        .set({ accountDeletedAt: new Date(`${dayOf(2)}T12:00:00Z`) })
        .where(eq(employments.id, world.employmentId));

      const res = await request(server.url)
        .get("/api/attendance/team")
        .query({ organizationId: world.organizationId, from: dayOf(0), to: dayOf(6) })
        .set("Cookie", await authCookieFor(world.owner.id))
        .expect(200);

      const person = (
        res.body.people as {
          userId: string;
          accountDeleted: boolean;
          user: { name: string };
          days: { requiredMinutes: number; exclusion: { cause: string } | null }[];
        }[]
      ).find((row) => row.userId === world.member.id);
      expect(person).toMatchObject({ accountDeleted: true, user: { name: MEMBER } });
      expect(person!.days.slice(0, 3).map((day) => day.exclusion)).toEqual([null, null, null]);
      expect(person!.days.slice(3).map((day) => day.exclusion?.cause)).toEqual([
        "NOT_EMPLOYED",
        "NOT_EMPLOYED",
        "NOT_EMPLOYED",
        "NOT_EMPLOYED",
      ]);
      expect(person!.days.slice(3).every((day) => day.requiredMinutes === 0)).toBe(true);

      const owner = (res.body.people as { userId: string; accountDeleted: boolean }[]).find(
        (row) => row.userId === world.owner.id
      );
      expect(owner?.accountDeleted).toBe(false);
    });
  });

  describe("names", () => {
    it("shows the frozen name on calendars and reports, and labels member lists", async () => {
      const world = await setUp();
      expect((await deleteAccount(world.member.email)).status).toBe(204);
      const asOwner = async (path: string) =>
        request(server.url)
          .get(path)
          .set("Cookie", await authCookieFor(world.owner.id))
          .expect(200);

      const calendar = await asOwner(
        `/api/vacation/calendar?year=${FUTURE_DAY.slice(0, 4)}&month=${Number(FUTURE_DAY.slice(5, 7)).toString()}&groupId=${world.groupId}`
      );
      const cell = (calendar.body as { id: string; user: { name: string } }[]).find(
        (row) => row.id === world.futureId
      );
      expect(cell?.user.name).toBe(MEMBER);
      expect(cell?.user).not.toHaveProperty("accountDeleted");

      const report = await asOwner(
        `/api/reports/members/${world.owner.id}?year=${new Date().getUTCFullYear().toString()}`
      );
      expect(
        (report.body.changes as { actor: { id: string; name: string } | null }[])[0]?.actor
      ).toMatchObject({ id: world.member.id, name: MEMBER });

      const members = await asOwner(`/api/group-user/${world.groupId}`);
      expect(
        (members.body as { userId: string; accountDeleted: boolean; user: { name: string } }[]).map(
          (row) => ({ userId: row.userId, name: row.user.name, accountDeleted: row.accountDeleted })
        )
      ).toEqual(
        expect.arrayContaining([
          { userId: world.member.id, name: MEMBER, accountDeleted: true },
          { userId: world.owner.id, name: OWNER, accountDeleted: false },
        ])
      );

      const roster = await asOwner(`/api/employment/list?organizationId=${world.organizationId}`);
      expect(
        (roster.body as { userId: string; accountDeleted: boolean }[]).find(
          (row) => row.userId === world.member.id
        )
      ).toMatchObject({ accountDeleted: true, user: { name: MEMBER } });
    });

    it("reads Deleted account once the organization holds no Employment for the person", async () => {
      const world = await setUp();
      expect((await deleteAccount(world.member.email)).status).toBe(204);
      await db.delete(employments).where(eq(employments.id, world.employmentId));

      const report = await request(server.url)
        .get(
          `/api/reports/members/${world.owner.id}?year=${new Date().getUTCFullYear().toString()}`
        )
        .set("Cookie", await authCookieFor(world.owner.id))
        .expect(200);

      expect(
        (report.body.changes as { actor: { id: string; name: string } | null }[])[0]?.actor
      ).toMatchObject({ id: world.member.id, name: "Deleted account" });
    });

    it("keeps the frozen copy when another organization's name differs", async () => {
      const world = await setUp();
      const other = await makeUser("Other Owner");
      const otherOrganizationId = (await ensureOrganizationForUser(other.id)).id;
      await db.insert(organizationUsers).values({
        id: uuidv4(),
        organizationId: otherOrganizationId,
        userId: world.member.id,
        grantedByUserId: other.id,
      });
      await syncEmployment(otherOrganizationId, world.member.id);
      await db
        .update(employments)
        .set({ name: "J. Nováková" })
        .where(
          and(
            eq(employments.organizationId, otherOrganizationId),
            eq(employments.userId, world.member.id)
          )
        );

      expect((await deleteAccount(world.member.email)).status).toBe(204);

      const copies = await db
        .select({ organizationId: employments.organizationId, name: employments.name })
        .from(employments)
        .where(eq(employments.userId, world.member.id));
      expect(copies).toEqual(
        expect.arrayContaining([
          { organizationId: world.organizationId, name: MEMBER },
          { organizationId: otherOrganizationId, name: "J. Nováková" },
        ])
      );
    });
  });
});
