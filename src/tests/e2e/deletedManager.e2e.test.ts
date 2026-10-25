import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { changesSchema, changesType } from "../../db/schema/changes-schema.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import {
  WEB_TEST_PASSWORD,
  authCookieFor,
  createWebUser,
  webSessionCookieFor,
} from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addQuota,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const weekdayFromNow = (days: number): string => {
  const date = new Date(Date.now() + days * DAY_MS);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + (days < 0 ? -1 : 1));
  }
  return date.toISOString().slice(0, 10);
};

describe("a deleted group manager", () => {
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

  /**
   * Olga owns the organization; Martin manages its Support group, where he
   * and Petra are members. `managerIsMember: false` leaves Martin with the
   * group as his only link to the organization.
   */
  const setUp = async ({ managerIsMember = true } = {}) => {
    const owner = await makeUser("Olga Owner");
    const manager = await createWebUser("Martin Manager");
    const member = await makeUser("Petra Member");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const groupId = await makeGroup("Support", manager.id, { organizationOwnerId: owner.id });
    if (managerIsMember) {
      await addMember(groupId, manager.id, {
        viewAccess: true,
        adminAccess: true,
        approverAccess: true,
      });
    }
    await addMember(groupId, member.id);
    for (const id of [owner.id, manager.id, member.id]) {
      await syncEmployment(organizationId, id);
    }
    return { owner, manager, member, organizationId, groupId };
  };

  const deleteAccount = async (email: string) => {
    const cookie = await webSessionCookieFor(server.url, email);
    return request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", cookie)
      .send({ password: WEB_TEST_PASSWORD });
  };

  describe("deletion blockers", () => {
    const blockersOf = async (userId: string) => {
      const res = await request(server.url)
        .get("/api/users/me/deletion")
        .set("Cookie", await authCookieFor(userId));
      expect(res.status).toBe(200);
      return res.body as { canDelete: boolean; blockers: { kind: string }[] };
    };

    it("lets a manager go whose group, with members, is in someone else's organization", async () => {
      const world = await setUp();

      expect(await blockersOf(world.manager.id)).toEqual(
        expect.objectContaining({ canDelete: true, blockers: [] })
      );
    });

    it("lets an owner go whose own group holds only Deleted accounts", async () => {
      const world = await setUp();
      expect((await deleteAccount(world.manager.email)).status).toBe(204);
      const own = await makeGroup("Owner's Team", world.owner.id);
      await addMember(own, world.manager.id);
      await db
        .update(groupUsers)
        .set({ deletedAt: new Date() })
        .where(and(eq(groupUsers.groupId, world.groupId), eq(groupUsers.userId, world.member.id)));
      await syncEmployment(world.organizationId, world.member.id);

      expect(await blockersOf(world.owner.id)).toEqual(
        expect.objectContaining({ canDelete: true, blockers: [] })
      );
    });
  });

  describe("account deletion", () => {
    it("hands the group to the owner and keeps the manager's membership, bookings and Employment", async () => {
      const world = await setUp();
      const year = new Date().getUTCFullYear();
      await addQuota(world.groupId, world.manager.id, year);
      const bookingId = await addLeave(world.groupId, world.manager.id, weekdayFromNow(21), {
        approvedBy: world.owner.id,
      });

      const res = await deleteAccount(world.manager.email);

      expect(res.status).toBe(204);
      const [group] = await db.select().from(groups).where(eq(groups.id, world.groupId));
      expect(group).toMatchObject({ managerUserId: world.owner.id, deletedAt: null });

      const [membership] = await db
        .select()
        .from(groupUsers)
        .where(and(eq(groupUsers.groupId, world.groupId), eq(groupUsers.userId, world.manager.id)));
      expect(membership).toMatchObject({
        deletedAt: null,
        viewAccess: false,
        adminAccess: false,
        approverAccess: false,
      });

      const [booking] = await db.select().from(vacation).where(eq(vacation.id, bookingId));
      expect(booking).toMatchObject({ deletedAt: null });

      const [employment] = await db
        .select()
        .from(employments)
        .where(
          and(
            eq(employments.organizationId, world.organizationId),
            eq(employments.userId, world.manager.id)
          )
        );
      expect(employment?.endedAt).toBeNull();
      expect(employment?.accountDeletedAt).not.toBeNull();
    });

    it("keeps the Employment open when managing the group was the manager's only link", async () => {
      const world = await setUp({ managerIsMember: false });

      const res = await deleteAccount(world.manager.email);

      expect(res.status).toBe(204);
      const [employment] = await db
        .select()
        .from(employments)
        .where(
          and(
            eq(employments.organizationId, world.organizationId),
            eq(employments.userId, world.manager.id)
          )
        );
      expect(employment).toMatchObject({ endedAt: null });
      expect(employment?.accountDeletedAt).not.toBeNull();
    });

    it("gives the owner no membership, quota or seat in the group", async () => {
      const world = await setUp();
      const seatsBefore = await db
        .select()
        .from(groupUsers)
        .where(eq(groupUsers.groupId, world.groupId));

      const res = await deleteAccount(world.manager.email);

      expect(res.status).toBe(204);
      const seats = await db.select().from(groupUsers).where(eq(groupUsers.groupId, world.groupId));
      expect(seats.map((row) => row.userId).sort()).toEqual(
        seatsBefore.map((row) => row.userId).sort()
      );
      expect(seats.some((row) => row.userId === world.owner.id)).toBe(false);
      expect(
        await db
          .select()
          .from(userYearQuotas)
          .where(
            and(
              eq(userYearQuotas.groupId, world.groupId),
              eq(userYearQuotas.userId, world.owner.id)
            )
          )
      ).toHaveLength(0);
    });
  });
  describe("Change manager", () => {
    const changeManager = async (callerId: string, groupId: string, managerUserId: unknown) =>
      request(server.url)
        .put(`/api/group/${groupId}/manager`)
        .set("Cookie", await authCookieFor(callerId))
        .send({ managerUserId });

    const codeOf = (res: request.Response) =>
      (res.body as { errors?: { context?: { code?: string } }[] }).errors?.[0]?.context?.code;

    const delegateIn = async (organizationId: string, groupId?: string) => {
      const delegate = await makeUser("Dana Delegate");
      await db
        .insert(organizationUsers)
        .values({ id: uuidv4(), organizationId, userId: delegate.id });
      if (groupId) await addMember(groupId, delegate.id);
      await syncEmployment(organizationId, delegate.id);
      return delegate;
    };

    it("lets the owner name a live member, and logs the change", async () => {
      const world = await setUp();

      const res = await changeManager(world.owner.id, world.groupId, world.member.id);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: world.groupId, managerUserId: world.member.id });
      const [group] = await db.select().from(groups).where(eq(groups.id, world.groupId));
      expect(group?.managerUserId).toBe(world.member.id);
      const changes = await db
        .select()
        .from(changesSchema)
        .where(eq(changesSchema.groupId, world.groupId));
      expect(changes).toEqual([
        expect.objectContaining({
          changeType: changesType.Group,
          changingUserId: world.owner.id,
          userId: world.member.id,
        }),
      ]);
    });

    it("lets a delegated org admin hand the owner's group on after a deletion", async () => {
      const world = await setUp();
      expect((await deleteAccount(world.manager.email)).status).toBe(204);
      const delegate = await delegateIn(world.organizationId);

      const res = await changeManager(delegate.id, world.groupId, world.member.id);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ managerUserId: world.member.id });
    });

    it("refuses the manager, a group admin by flag and a plain member", async () => {
      const world = await setUp();
      const groupAdmin = await makeUser("Gita Group Admin");
      await addMember(world.groupId, groupAdmin.id, { adminAccess: true });

      for (const callerId of [world.manager.id, groupAdmin.id, world.member.id]) {
        const res = await changeManager(callerId, world.groupId, world.member.id);
        expect(res.status).toBe(403);
      }
      const [group] = await db.select().from(groups).where(eq(groups.id, world.groupId));
      expect(group?.managerUserId).toBe(world.manager.id);
    });

    it("refuses someone who is not a member, a former member and a Deleted account", async () => {
      const world = await setUp();
      const outsider = await makeUser("Otto Outsider");
      const former = await makeUser("Fiona Former");
      await addMember(world.groupId, former.id);
      await db
        .update(groupUsers)
        .set({ deletedAt: new Date() })
        .where(and(eq(groupUsers.groupId, world.groupId), eq(groupUsers.userId, former.id)));

      for (const candidate of [outsider.id, former.id]) {
        const res = await changeManager(world.owner.id, world.groupId, candidate);
        expect(res.status).toBe(422);
        expect(codeOf(res)).toBe("NOT_A_MEMBER");
      }

      expect((await deleteAccount(world.manager.email)).status).toBe(204);
      const deleted = await changeManager(world.owner.id, world.groupId, world.manager.id);
      expect(deleted.status).toBe(422);
      expect(codeOf(deleted)).toBe("ACCOUNT_DELETED");

      const [group] = await db.select().from(groups).where(eq(groups.id, world.groupId));
      expect(group?.managerUserId).toBe(world.owner.id);
    });

    it("refuses an org admin who names themselves", async () => {
      const world = await setUp();
      const delegate = await delegateIn(world.organizationId, world.groupId);

      const res = await changeManager(delegate.id, world.groupId, delegate.id);

      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe("CANNOT_NAME_SELF");
    });

    it("answers 404 for an unknown group and 422 without a manager", async () => {
      const world = await setUp();

      expect((await changeManager(world.owner.id, uuidv4(), world.member.id)).status).toBe(404);
      expect((await changeManager(world.owner.id, world.groupId, "")).status).toBe(422);
    });

    it("tells the group screen who manages it and whether the caller may change that", async () => {
      const world = await setUp();
      const read = async (callerId: string) =>
        request(server.url)
          .get(`/api/group/${world.groupId}`)
          .set("Cookie", await authCookieFor(callerId));

      const asOwner = await read(world.owner.id);
      expect(asOwner.status).toBe(200);
      expect(asOwner.body).toMatchObject({
        managerName: "Martin Manager",
        access: { canChangeManager: true },
      });

      const asManager = await read(world.manager.id);
      expect(asManager.body).toMatchObject({ access: { canChangeManager: false } });
    });
  });
});
