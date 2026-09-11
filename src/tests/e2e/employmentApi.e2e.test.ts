import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { createServer } from "../../server.js";
import { cleanupTestData, createTestUser } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { createGroup } from "../../services/group/groupServices.js";
import {
  createGroupUser,
  deleteGroupUser,
  getGroupUser,
} from "../../services/groupUser/groupUserServices.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

/**
 * The visibility matrix of `docs/attendance.md` over the two endpoints:
 * an employee sees their own Employment, a group admin their group's members,
 * an org admin the organization. The two people deliberately in no group — a
 * manager and a delegated admin — are what pins the last row of that table.
 */
describe("employment endpoints", () => {
  let app: Express;
  let organizationId: string;

  let owner: { id: string };
  /** Delegated org admin belonging to no group. */
  let delegate: { id: string };
  /** Manages Engineering; holds no `group_users` row anywhere. */
  let manager: { id: string };
  let engineer: { id: string };
  /** Manages Support, the group the Engineering admin may not see into. */
  let otherManager: { id: string };
  let supporter: { id: string };
  /** Was in Engineering and was removed — an ended Employment. */
  let former: { id: string };
  let outsider: { id: string };

  const cookies: Record<string, string> = {};

  const userOf = async (slug: string) =>
    createTestUser(`employment-${slug}@test.com`, `Employment ${slug}`, "password123");

  const newGroup = async (groupName: string, managerUserId: string) => {
    const record = await createGroup({ id: uuidv4(), organizationId, groupName, managerUserId });
    return record!.id;
  };

  const addMember = async (groupId: string, userId: string) =>
    createGroupUser({ id: uuidv4(), groupId, userId, viewAccess: true, controlledUser: true });

  const listAs = (cookie: string, id = organizationId) =>
    request(app).get("/api/employment/list").query({ organizationId: id }).set("Cookie", cookie);

  const getAs = (cookie: string, userId?: string, id = organizationId) =>
    request(app)
      .get("/api/employment")
      .query({ organizationId: id, ...(userId ? { userId } : {}) })
      .set("Cookie", cookie);

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    owner = await userOf("owner");
    delegate = await userOf("delegate");
    manager = await userOf("manager");
    engineer = await userOf("engineer");
    otherManager = await userOf("other-manager");
    supporter = await userOf("supporter");
    former = await userOf("former");
    outsider = await userOf("outsider");

    organizationId = (await ensureOrganizationForUser(owner.id)).id;

    const engineering = await newGroup("Engineering", manager.id);
    const support = await newGroup("Support", otherManager.id);
    await addMember(engineering, engineer.id);
    await addMember(support, supporter.id);

    await addMember(engineering, former.id);
    const leaving = await getGroupUser(former.id, engineering);
    await deleteGroupUser(leaving!.id);

    await grantOrganizationAdmin({
      organizationId,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });

    for (const [name, person] of Object.entries({
      owner,
      delegate,
      manager,
      engineer,
      otherManager,
      supporter,
      former,
      outsider,
    })) {
      cookies[name] = await authCookieFor(person.id);
    }
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("one Employment", () => {
    it("answers an ordinary employee with their own row", async () => {
      const res = await getAs(cookies.engineer!).expect(200);

      expect(res.body).toMatchObject({
        organizationId,
        userId: engineer.id,
        ended: false,
        endedAt: null,
        requiredMinutesPerDay: null,
      });
    });

    it("answers a manager who belongs to no group", async () => {
      const res = await getAs(cookies.manager!).expect(200);

      expect(res.body).toMatchObject({ userId: manager.id, ended: false });
    });

    it("still answers someone whose Employment has ended", async () => {
      const res = await getAs(cookies.former!).expect(200);

      expect(res.body).toMatchObject({ userId: former.id, ended: true });
      expect(res.body.endedAt).not.toBeNull();
    });

    it("404s for someone with no Employment in that organization", async () => {
      await getAs(cookies.outsider!).expect(404);
    });

    it("422s without an organization to answer about", async () => {
      await request(app).get("/api/employment").set("Cookie", cookies.engineer!).expect(422);
    });

    describe("asking about someone else", () => {
      it("refuses a colleague in the same group", async () => {
        await getAs(cookies.engineer!, supporter.id).expect(403);
        await getAs(cookies.supporter!, engineer.id).expect(403);
      });

      it("allows the admin of a group that person belongs to", async () => {
        const res = await getAs(cookies.manager!, engineer.id).expect(200);

        expect(res.body).toMatchObject({ userId: engineer.id });
      });

      it("refuses the admin of a group that person does not belong to", async () => {
        await getAs(cookies.otherManager!, engineer.id).expect(403);
      });

      it("refuses a group admin the two people who belong to no group", async () => {
        await getAs(cookies.manager!, otherManager.id).expect(403);
        await getAs(cookies.manager!, delegate.id).expect(403);
      });

      it("allows the owner and a delegated admin anyone in the organization", async () => {
        await getAs(cookies.owner!, manager.id).expect(200);
        await getAs(cookies.delegate!, engineer.id).expect(200);
        await getAs(cookies.owner!, former.id).expect(200);
      });

      // Otherwise the endpoint would answer "who works here" to anyone with an
      // account, one guessed id at a time.
      it("answers 403 rather than 404 for someone with no Employment at all", async () => {
        await getAs(cookies.manager!, outsider.id).expect(403);
      });
    });
  });

  describe("the roster", () => {
    it("gives the owner every Employment, ended ones included", async () => {
      const res = await listAs(cookies.owner!).expect(200);

      expect(res.body.map((row: { userId: string }) => row.userId).sort()).toEqual(
        [owner.id, delegate.id, manager.id, engineer.id, otherManager.id, supporter.id, former.id]
          .slice()
          .sort()
      );
      expect(res.body.find((row: { userId: string }) => row.userId === former.id)).toMatchObject({
        ended: true,
      });
    });

    it("gives a delegated org admin the same organization-wide view", async () => {
      const forOwner = await listAs(cookies.owner!).expect(200);
      const forDelegate = await listAs(cookies.delegate!).expect(200);

      expect(forDelegate.body).toEqual(forOwner.body);
    });

    it("carries each person's name and email", async () => {
      const res = await listAs(cookies.owner!).expect(200);

      expect(res.body.find((row: { userId: string }) => row.userId === engineer.id)).toMatchObject({
        email: "employment-engineer@test.com",
        user: { name: "Employment engineer" },
      });
    });

    // Not the manager themselves: they hold no membership row, so the roster
    // they administer does not contain them. Their own row is on `GET
    // /api/employment`, asserted above.
    it("gives a group admin their groups' members, nobody else", async () => {
      const res = await listAs(cookies.manager!).expect(200);

      expect(res.body.map((row: { userId: string }) => row.userId)).toEqual([engineer.id]);
    });

    it("does not reach into a group the caller does not administer", async () => {
      const res = await listAs(cookies.otherManager!).expect(200);
      const userIds = res.body.map((row: { userId: string }) => row.userId);

      expect(userIds).toEqual([supporter.id]);
      expect(userIds).not.toContain(engineer.id);
      // Nor the two people who belong to no group at all.
      expect(userIds).not.toContain(manager.id);
      expect(userIds).not.toContain(delegate.id);
    });

    it("refuses an ordinary employee — their own row is on /me", async () => {
      await listAs(cookies.engineer!).expect(403);
    });

    it("refuses someone outside the organization entirely", async () => {
      await listAs(cookies.outsider!).expect(403);
    });
  });

  describe("the billing overview's headcount", () => {
    it("counts the organization's active Employments", async () => {
      const res = await request(app)
        .get("/api/billing/subscription")
        .set("Cookie", cookies.owner!)
        .expect(200);

      // Seven people, one of whom has left.
      expect(res.body.usage.activeEmployments).toBe(6);
      // Headcount is not the sum of the group meters: it counts the manager
      // and the delegated admin, who hold no membership anywhere.
      expect(
        res.body.usage.groups.reduce((sum: number, g: { members: number }) => sum + g.members, 0)
      ).toBe(2);
    });

    it("gives a caller who administers no organization zero", async () => {
      const res = await request(app)
        .get("/api/billing/subscription")
        .set("Cookie", cookies.outsider!)
        .expect(200);

      expect(res.body.usage.activeEmployments).toBe(0);
    });
  });
});
