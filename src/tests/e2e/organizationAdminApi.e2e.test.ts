import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
  isOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

/**
 * The org-admin authority as the HTTP surface actually exposes it. The service
 * helpers have their own suite; this one exists because those helpers being
 * right is worthless if no handler calls them — reverting the widening must
 * fail here.
 */
describe("organization admin over the API", () => {
  let app: Express;

  let owner: { id: string };
  /** Org admin, deliberately never a member of the group. */
  let delegate: { id: string };
  let member: { id: string };
  let outsider: { id: string };

  let ownerCookie: string;
  let delegateCookie: string;
  let outsiderCookie: string;

  let organizationId: string;
  let groupId: string;

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    owner = await createTestUser("api-owner@test.com", "Olivia Owner", "password123");
    delegate = await createTestUser("api-delegate@test.com", "Dana Delegate", "password123");
    member = await createTestUser("api-member@test.com", "Milo Member", "password123");
    outsider = await createTestUser("api-outsider@test.com", "Otto Outsider", "password123");

    organizationId = (await ensureOrganizationForUser(owner.id)).id;

    groupId = uuidv4();
    await db.insert(groups).values({
      id: groupId,
      organizationId,
      groupName: "Engineering",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });

    await db.insert(groupUsers).values([
      {
        id: uuidv4(),
        userId: owner.id,
        groupId,
        viewAccess: true,
        adminAccess: true,
        approverAccess: true,
        controlledUser: true,
      },
      {
        id: uuidv4(),
        userId: member.id,
        groupId,
        viewAccess: true,
        adminAccess: false,
        approverAccess: false,
        controlledUser: true,
      },
    ]);

    await db.insert(userYearQuotas).values({
      id: uuidv4(),
      userId: member.id,
      groupId,
      relatedYear: "2026",
      vacationDays: 20,
      homeOfficeDays: 0,
    });

    await grantOrganizationAdmin({
      organizationId,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });

    ownerCookie = await authCookieFor(owner.id);
    delegateCookie = await authCookieFor(delegate.id);
    outsiderCookie = await authCookieFor(outsider.id);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("reaching a group they do not belong to", () => {
    it("returns the group with organization authority flagged", async () => {
      const res = await request(app)
        .get(`/api/group/${groupId}`)
        .set("Cookie", delegateCookie)
        .expect(200);

      expect(res.body.access).toEqual({
        canView: true,
        canAdmin: true,
        viaOrgAdmin: true,
        isMember: false,
      });
      expect(res.body.organization).toMatchObject({ id: organizationId, plan: "FREE" });
    });

    it("keeps the group out of their own group list", async () => {
      // `GET /api/group` also drives the dashboard and the request dialog, so a
      // group they merely administer must not appear there.
      const res = await request(app).get("/api/group").set("Cookie", delegateCookie).expect(200);

      expect(res.body).toEqual([]);
    });

    it("lists the group's members", async () => {
      const res = await request(app)
        .get(`/api/group-user/${groupId}`)
        .set("Cookie", delegateCookie)
        .expect(200);

      expect(res.body.map((row: { userId: string }) => row.userId)).toContain(member.id);
    });

    it("reads the group's quotas", async () => {
      await request(app)
        .get(`/api/quotas/${groupId}?year=2026`)
        .set("Cookie", delegateCookie)
        .expect(200);
    });

    it("changes a member's permissions", async () => {
      await request(app)
        .put("/api/group-user")
        .set("Cookie", delegateCookie)
        .send({
          groupId,
          data: [
            {
              userId: member.id,
              viewAccess: true,
              adminAccess: true,
              approverAccess: false,
              controlledUser: true,
            },
          ],
        })
        .expect(200);
    });

    it("edits the group's default quotas", async () => {
      await request(app)
        .put(`/api/group/${groupId}/quotas`)
        .set("Cookie", delegateCookie)
        .send({ defaultVacationDays: 25, defaultHomeOfficeDays: 5 })
        .expect(200);
    });

    it("edits the group's working days", async () => {
      await request(app)
        .put(`/api/group/${groupId}/working-days`)
        .set("Cookie", delegateCookie)
        .send({ workingDays: [1, 2, 3, 4] })
        .expect(200);
    });

    it("sets a member's individual quota", async () => {
      await request(app)
        .put(`/api/quotas/${groupId}`)
        .set("Cookie", delegateCookie)
        .send({
          userId: member.id,
          year: 2026,
          vacationDays: 22,
          homeOfficeDays: 3,
          carriedOverDays: 0,
        })
        .expect(200);
    });
  });

  describe("limits of the authority", () => {
    it("refuses a stranger everywhere", async () => {
      await request(app).get(`/api/group/${groupId}`).set("Cookie", outsiderCookie).expect(403);
      await request(app)
        .get(`/api/group-user/${groupId}`)
        .set("Cookie", outsiderCookie)
        .expect(403);
      await request(app)
        .put(`/api/group/${groupId}/quotas`)
        .set("Cookie", outsiderCookie)
        .send({ defaultVacationDays: 1, defaultHomeOfficeDays: 1 })
        .expect(403);
    });

    it("will not let an org admin raise their own permissions", async () => {
      // The escalation this closes: invite yourself in, then grant yourself the
      // approver rights the organization role deliberately withholds.
      await db.insert(groupUsers).values({
        id: uuidv4(),
        userId: delegate.id,
        groupId,
        viewAccess: true,
        adminAccess: false,
        approverAccess: false,
        controlledUser: true,
      });

      await request(app)
        .put("/api/group-user")
        .set("Cookie", delegateCookie)
        .send({
          groupId,
          data: [
            {
              userId: delegate.id,
              viewAccess: true,
              adminAccess: true,
              approverAccess: true,
              controlledUser: true,
            },
          ],
        })
        .expect(403);
    });

    it("will not let a repeated self-entry sneak the raise past the check", async () => {
      // The handler applies every record in order, so checking only the first
      // match would let a harmless one pass while a later one escalates.
      await request(app)
        .put("/api/group-user")
        .set("Cookie", delegateCookie)
        .send({
          groupId,
          data: [
            {
              userId: delegate.id,
              viewAccess: true,
              adminAccess: false,
              approverAccess: false,
              controlledUser: true,
            },
            {
              userId: delegate.id,
              viewAccess: true,
              adminAccess: true,
              approverAccess: true,
              controlledUser: true,
            },
          ],
        })
        .expect(403);
    });

    it("will not let an org admin grant approver rights to anyone", async () => {
      // Blocking only self-grants leaves the obvious way around it: invite a
      // second account you control, then promote that one instead.
      await request(app)
        .put("/api/group-user")
        .set("Cookie", delegateCookie)
        .send({
          groupId,
          data: [
            {
              userId: member.id,
              viewAccess: true,
              adminAccess: false,
              approverAccess: true,
              controlledUser: true,
            },
          ],
        })
        .expect(403);
    });

    it("still lets an org admin manage the non-approver permissions", async () => {
      await request(app)
        .put("/api/group-user")
        .set("Cookie", delegateCookie)
        .send({
          groupId,
          data: [
            {
              userId: member.id,
              viewAccess: true,
              adminAccess: true,
              approverAccess: false,
              controlledUser: true,
            },
          ],
        })
        .expect(200);
    });

    it("will not let an org admin name themselves the group's approver", async () => {
      // The approver columns are approval authority by another name; blocking
      // only `approverAccess` would leave this route as the way around it.
      await request(app)
        .put(`/api/group/${groupId}/approvers`)
        .set("Cookie", delegateCookie)
        .send({ mainApprovalUser: delegate.id, tempApprovalUser: null })
        .expect(403);
    });

    it("still lets an org admin name someone else the approver", async () => {
      await request(app)
        .put(`/api/group/${groupId}/approvers`)
        .set("Cookie", delegateCookie)
        .send({ mainApprovalUser: member.id, tempApprovalUser: null })
        .expect(200);
    });

    it("revokes the org grant when they leave the organization's last group", async () => {
      expect(await isOrganizationAdmin(delegate.id, organizationId)).toBe(true);

      await request(app)
        .delete(`/api/group-user/${groupId}/${delegate.id}`)
        .set("Cookie", ownerCookie)
        .expect(200);

      expect(await isOrganizationAdmin(delegate.id, organizationId)).toBe(false);
      await request(app).get(`/api/group/${groupId}`).set("Cookie", delegateCookie).expect(403);
    });
  });

  describe("organization endpoints", () => {
    it("lets the owner rename the organization", async () => {
      await request(app)
        .patch("/api/organization")
        .set("Cookie", ownerCookie)
        .send({ name: "Acme Renamed" })
        .expect(200);
    });

    it("refuses a delegated admin the billing address", async () => {
      await grantOrganizationAdmin({
        organizationId,
        userId: delegate.id,
        grantedByUserId: owner.id,
      });

      await request(app)
        .patch(`/api/organization?organizationId=${organizationId}`)
        .set("Cookie", delegateCookie)
        .send({ billingEmail: "attacker@evil.test" })
        .expect(403);
    });

    it("refuses a delegated admin the candidate list and the grant routes", async () => {
      await request(app)
        .get(`/api/organization/candidates?organizationId=${organizationId}`)
        .set("Cookie", delegateCookie)
        .expect(403);

      await request(app)
        .post(`/api/organization/admins?organizationId=${organizationId}`)
        .set("Cookie", delegateCookie)
        .send({ userId: outsider.id })
        .expect(403);
    });

    it("refuses to grant admin to someone outside the organization's groups", async () => {
      await request(app)
        .post("/api/organization/admins")
        .set("Cookie", ownerCookie)
        .send({ userId: outsider.id })
        .expect(422);
    });

    it("hides the billing address from a delegated admin's own read", async () => {
      const res = await request(app)
        .get(`/api/organization?organizationId=${organizationId}`)
        .set("Cookie", delegateCookie)
        .expect(200);

      expect(res.body.organization.billingEmail).toBeNull();
      expect(res.body.organization.isOwner).toBe(false);
    });

    it("gives the owner the billing address", async () => {
      const res = await request(app)
        .get("/api/organization")
        .set("Cookie", ownerCookie)
        .expect(200);

      expect(res.body.organization.isOwner).toBe(true);
      expect(res.body.organization.billingEmail).toBe("api-owner@test.com");
    });

    it("404s for a user with no organization at all", async () => {
      await request(app).get("/api/organization").set("Cookie", outsiderCookie).expect(404);
    });
  });
});
