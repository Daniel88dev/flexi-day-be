import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { vacationEvents, vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import {
  WEB_TEST_PASSWORD,
  authCookieFor,
  createWebUser,
  webSessionCookieFor,
} from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ZONE = "Europe/Prague";
const DAY_MS = 24 * 60 * 60 * 1000;

const shift = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

describe("ending an Employment", () => {
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

  const employmentOf = async (organizationId: string, userId: string) => {
    const [row] = await db
      .select()
      .from(employments)
      .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)));
    return row!;
  };

  const deleteAccount = async (email: string) => {
    const cookie = await webSessionCookieFor(server.url, email);
    const res = await request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", cookie)
      .send({ password: WEB_TEST_PASSWORD });
    expect(res.status).toBe(204);
  };

  /**
   * A Free organization with attendance off, owned by Olga, with two groups.
   * Jana belongs to both, Dana is a delegated org admin and Gina manages the
   * second group. Jana also belongs to Olga's friend's organization.
   */
  const setUp = async (options: { deleteMember?: boolean } = {}) => {
    const owner = await makeUser("Olga Owner");
    const member = await createWebUser("Jana Nováková");
    const delegate = await makeUser("Dana Delegate");
    const groupManager = await makeUser("Gina Manager");
    const plainMember = await makeUser("Pavel Plain");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await upsertAttendanceSettings(organizationId, { timezone: ZONE });

    const first = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    const second = await makeGroup("Sales", groupManager.id, { organizationOwnerId: owner.id });
    await addMember(first, owner.id, { adminAccess: true, approverAccess: true, viewAccess: true });
    await addMember(first, member.id, { viewAccess: true });
    await addMember(second, groupManager.id, { adminAccess: true, viewAccess: true });
    await addMember(second, member.id, { viewAccess: true });
    await addMember(first, delegate.id);
    await addMember(first, plainMember.id);
    await db.insert(organizationUsers).values({
      id: uuidv4(),
      organizationId,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });
    for (const id of [owner.id, member.id, delegate.id, groupManager.id, plainMember.id]) {
      await syncEmployment(organizationId, id);
    }
    await db
      .update(employments)
      .set({ startedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(employments.organizationId, organizationId));

    const friend = await makeUser("Fiona Friend");
    const elsewhere = await makeGroup("Elsewhere", friend.id);
    await addMember(elsewhere, member.id);
    const elsewhereOrganizationId = (await ensureOrganizationForUser(friend.id)).id;
    await syncEmployment(elsewhereOrganizationId, member.id);

    const today = businessDateInZone(new Date(), ZONE);
    const bookings = {
      past: await addLeave(first, member.id, shift(today, -7), { approvedBy: owner.id }),
      today: await addLeave(second, member.id, today, { approvedBy: groupManager.id }),
      tomorrow: await addLeave(first, member.id, shift(today, 1), { approvedBy: owner.id }),
      later: await addLeave(second, member.id, shift(today, 30), { approvedBy: groupManager.id }),
      elsewhere: await addLeave(elsewhere, member.id, shift(today, 31), { approvedBy: friend.id }),
    };

    if (options.deleteMember) await deleteAccount(member.email);

    // A request the deletion would have cancelled: left over from before it.
    const pendingPast = await addLeave(first, member.id, shift(today, -3), { approved: false });

    return {
      owner,
      member,
      delegate,
      groupManager,
      plainMember,
      organizationId,
      elsewhereOrganizationId,
      first,
      second,
      today,
      bookings: { ...bookings, pendingPast },
      employment: await employmentOf(organizationId, member.id),
    };
  };

  const end = async (callerId: string, employmentId: string, endedOn: string) =>
    request(server.url)
      .post(`/api/employment/${employmentId}/end`)
      .set("Cookie", await authCookieFor(callerId))
      .send({ endedOn });

  const live = async (vacationId: string) => {
    const [row] = await db.select().from(vacation).where(eq(vacation.id, vacationId));
    return row!.deletedAt === null;
  };

  describe("on a Deleted account, on Free with attendance off", () => {
    it("removes every membership, cancels pending and from-tomorrow bookings, and ends on the date", async () => {
      const world = await setUp({ deleteMember: true });
      const endedOn = shift(world.today, -1);

      const res = await end(world.owner.id, world.employment.id, endedOn);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: world.employment.id,
        ended: true,
        cancelledBookings: 3,
      });

      const after = await employmentOf(world.organizationId, world.member.id);
      expect(businessDateInZone(after.endedAt!, ZONE)).toBe(endedOn);

      const memberships = await db
        .select()
        .from(groupUsers)
        .where(and(eq(groupUsers.userId, world.member.id), isNull(groupUsers.deletedAt)));
      expect(memberships.map((row) => row.groupId)).toEqual([
        (await db.select().from(groups).where(eq(groups.groupName, "Elsewhere")))[0]!.id,
      ]);

      expect(await live(world.bookings.past)).toBe(true);
      expect(await live(world.bookings.today)).toBe(true);
      expect(await live(world.bookings.tomorrow)).toBe(false);
      expect(await live(world.bookings.later)).toBe(false);
      expect(await live(world.bookings.pendingPast)).toBe(false);
      expect(await live(world.bookings.elsewhere)).toBe(true);

      const [cancelled] = await db
        .select()
        .from(vacationEvents)
        .where(eq(vacationEvents.vacationId, world.bookings.tomorrow));
      expect(cancelled).toMatchObject({
        eventType: vacationEventType.Cancelled,
        actorUserId: world.owner.id,
        reason: "employment ended",
      });
      const [row] = await db.select().from(vacation).where(eq(vacation.id, world.bookings.later));
      expect(row!.deletedByUserId).toBe(world.owner.id);

      const elsewhereEmployment = await employmentOf(
        world.elsewhereOrganizationId,
        world.member.id
      );
      expect(elsewhereEmployment.endedAt).toBeNull();
    });

    it("drops a delegated admin row the person still held", async () => {
      const world = await setUp({ deleteMember: true });
      await db.insert(organizationUsers).values({
        id: uuidv4(),
        organizationId: world.organizationId,
        userId: world.member.id,
        grantedByUserId: world.owner.id,
      });

      const res = await end(world.delegate.id, world.employment.id, world.today);
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(organizationUsers)
        .where(
          and(eq(organizationUsers.userId, world.member.id), isNull(organizationUsers.deletedAt))
        );
      expect(rows).toEqual([]);
    });
  });

  describe("refusals", () => {
    it("refuses a date after today", async () => {
      const world = await setUp({ deleteMember: true });

      const res = await end(world.owner.id, world.employment.id, shift(world.today, 1));

      expect(res.status).toBe(422);
      expect(res.body.errors[0].context.code).toBe("END_DATE_IN_FUTURE");
      expect((await employmentOf(world.organizationId, world.member.id)).endedAt).toBeNull();
    });

    it("refuses a date before the Employment started", async () => {
      const world = await setUp({ deleteMember: true });

      const res = await end(world.owner.id, world.employment.id, "2019-12-31");

      expect(res.status).toBe(422);
      expect(res.body.errors[0].context.code).toBe("END_DATE_BEFORE_START");
    });

    it("refuses a person who manages a group, and changes nothing", async () => {
      const world = await setUp({ deleteMember: true });
      await db
        .update(groups)
        .set({ managerUserId: world.member.id })
        .where(eq(groups.id, world.second));

      const res = await end(world.owner.id, world.employment.id, world.today);

      expect(res.status).toBe(409);
      expect(res.body.errors[0].context.code).toBe("MANAGES_GROUP");
      expect(await live(world.bookings.later)).toBe(true);
      expect((await employmentOf(world.organizationId, world.member.id)).endedAt).toBeNull();
    });

    it("ends a live account too, and refuses the owner's own Employment", async () => {
      const world = await setUp();

      const res = await end(world.owner.id, world.employment.id, world.today);
      expect(res.status).toBe(200);
      expect((await employmentOf(world.organizationId, world.member.id)).endedAt).not.toBeNull();

      const own = await employmentOf(world.organizationId, world.owner.id);
      const refused = await end(world.owner.id, own.id, world.today);
      expect(refused.status).toBe(409);
      expect(refused.body.errors[0].context.code).toBe("OWNER_EMPLOYMENT");
    });

    it("refuses an Employment that already ended", async () => {
      const world = await setUp({ deleteMember: true });
      expect((await end(world.owner.id, world.employment.id, world.today)).status).toBe(200);

      const res = await end(world.owner.id, world.employment.id, world.today);

      expect(res.status).toBe(409);
      expect(res.body.errors[0].context.code).toBe("EMPLOYMENT_ENDED");
    });
  });

  describe("who may end", () => {
    it("refuses a group's manager and a plain member, and answers 404 for no such Employment", async () => {
      const world = await setUp({ deleteMember: true });

      expect((await end(world.groupManager.id, world.employment.id, world.today)).status).toBe(403);
      expect((await end(world.plainMember.id, world.employment.id, world.today)).status).toBe(403);
      expect((await end(world.owner.id, uuidv4(), world.today)).status).toBe(404);
      expect((await employmentOf(world.organizationId, world.member.id)).endedAt).toBeNull();
    });

    it("lets a delegated org admin end on a paid plan too", async () => {
      const world = await setUp({ deleteMember: true });
      await upsertSubscription(world.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });

      const res = await end(world.delegate.id, world.employment.id, world.today);

      expect(res.status).toBe(200);
      expect(res.body.ended).toBe(true);
    });
  });
  describe("the roster", () => {
    it("lists open Employments by name, then ended ones by end date, most recent first", async () => {
      const world = await setUp({ deleteMember: true });
      const endAt = async (userId: string, daysAgo: number) =>
        db
          .update(employments)
          .set({ endedAt: new Date(Date.now() - daysAgo * 86_400_000) })
          .where(
            and(
              eq(employments.organizationId, world.organizationId),
              eq(employments.userId, userId)
            )
          );
      await endAt(world.plainMember.id, 10);
      await endAt(world.member.id, 2);

      const res = await request(server.url)
        .get("/api/employment/list")
        .query({ organizationId: world.organizationId })
        .set("Cookie", await authCookieFor(world.owner.id))
        .expect(200);

      expect((res.body as { userId: string }[]).map((row) => row.userId)).toEqual([
        world.delegate.id,
        world.groupManager.id,
        world.owner.id,
        world.member.id,
        world.plainMember.id,
      ]);
    });
  });

  describe("removing a person from a group", () => {
    const removeFrom = async (callerId: string, groupId: string, userId: string) =>
      request(server.url)
        .delete(`/api/group-user/${groupId}/${userId}`)
        .set("Cookie", await authCookieFor(callerId));

    it("cancels their pending and from-tomorrow bookings in that group only, and ends the Employment with the last group", async () => {
      const world = await setUp();

      expect((await removeFrom(world.owner.id, world.first, world.member.id)).status).toBe(200);

      expect(await live(world.bookings.past)).toBe(true);
      expect(await live(world.bookings.tomorrow)).toBe(false);
      expect(await live(world.bookings.pendingPast)).toBe(false);
      expect(await live(world.bookings.today)).toBe(true);
      expect(await live(world.bookings.later)).toBe(true);
      expect(await live(world.bookings.elsewhere)).toBe(true);
      const [event] = await db
        .select()
        .from(vacationEvents)
        .where(eq(vacationEvents.vacationId, world.bookings.tomorrow));
      expect(event).toMatchObject({
        eventType: vacationEventType.Cancelled,
        actorUserId: world.owner.id,
        reason: "removed from group",
      });
      expect((await employmentOf(world.organizationId, world.member.id)).endedAt).toBeNull();

      expect((await removeFrom(world.groupManager.id, world.second, world.member.id)).status).toBe(
        200
      );

      expect(await live(world.bookings.today)).toBe(true);
      expect(await live(world.bookings.later)).toBe(false);
      expect((await employmentOf(world.organizationId, world.member.id)).endedAt).not.toBeNull();
    });
  });
  describe("a Deleted account's permissions", () => {
    const flags = (userId: string, values: Partial<Record<string, boolean>> = {}) => ({
      userId,
      viewAccess: false,
      adminAccess: false,
      approverAccess: false,
      controlledUser: true,
      ...values,
    });

    const putFlags = async (callerId: string, groupId: string, data: object[]) =>
      request(server.url)
        .put("/api/group-user")
        .set("Cookie", await authCookieFor(callerId))
        .send({ groupId, data });

    it("refuses granting view, admin or approver access back, and still lets tracking change", async () => {
      const world = await setUp({ deleteMember: true });

      for (const field of ["viewAccess", "adminAccess", "approverAccess"]) {
        const res = await putFlags(world.owner.id, world.first, [
          flags(world.member.id, { [field]: true }),
        ]);
        expect(res.status).toBe(422);
        expect(res.body.errors[0].context.code).toBe("ACCOUNT_DELETED");
      }

      const [membership] = await db
        .select()
        .from(groupUsers)
        .where(and(eq(groupUsers.groupId, world.first), eq(groupUsers.userId, world.member.id)));
      expect(membership).toMatchObject({
        viewAccess: false,
        adminAccess: false,
        approverAccess: false,
      });

      const untrack = await putFlags(world.owner.id, world.first, [
        flags(world.member.id, { controlledUser: false }),
      ]);
      expect(untrack.status).toBe(200);
    });

    it("refuses naming a Deleted account as an approver", async () => {
      const world = await setUp({ deleteMember: true });

      const res = await request(server.url)
        .put(`/api/group/${world.first}/approvers`)
        .set("Cookie", await authCookieFor(world.owner.id))
        .send({ mainApprovalUser: world.owner.id, tempApprovalUser: world.member.id });

      expect(res.status).toBe(422);
      expect(res.body.errors[0].context.code).toBe("ACCOUNT_DELETED");
    });
  });
});
