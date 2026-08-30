import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
  isOrganizationAdmin,
  listOrganizationAdminCandidates,
  listOrganizationAdmins,
  removeOrganizationAdmin,
  updateOrganization,
} from "../../services/organization/organizationServices.js";
import { resolveOrganizationBadges } from "../../services/organization/organizationBadge.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { getGroupsWhereUserCanApprove } from "../../services/group/groupServices.js";
import {
  getAdministrableGroupIds,
  resolveGroupAdmin,
  validateUserGroupAccess,
} from "../../services/groupUser/groupAccess.js";

/**
 * Org admins administer an organization's groups without belonging to them,
 * so the interesting cases all live in the gap between membership and
 * organization authority. Run against a real database.
 */
describe("organization admins", () => {
  let owner: { id: string };
  /** Promoted to org admin; deliberately never a member of any group. */
  let delegate: { id: string };
  /** A plain member of the org's group — an org member, not an org admin. */
  let member: { id: string };
  /** Owns a different organization entirely. */
  let outsider: { id: string };

  let organizationId: string;
  let outsiderOrganizationId: string;
  let groupId: string;

  const insertGroup = async (orgId: string, managerUserId: string, name: string) => {
    const id = uuidv4();
    await db.insert(groups).values({
      id,
      organizationId: orgId,
      groupName: name,
      managerUserId,
    });
    return id;
  };

  const addMember = (userId: string, targetGroupId: string, adminAccess = false) =>
    db.insert(groupUsers).values({
      id: uuidv4(),
      userId,
      groupId: targetGroupId,
      viewAccess: true,
      adminAccess,
      approverAccess: false,
      controlledUser: true,
    });

  beforeAll(async () => {
    await cleanupTestData();

    owner = await createTestUser("org-owner@test.com", "Org Owner", "password123");
    delegate = await createTestUser("org-delegate@test.com", "Org Delegate", "password123");
    member = await createTestUser("org-member@test.com", "Org Member", "password123");
    outsider = await createTestUser("org-outsider@test.com", "Org Outsider", "password123");

    organizationId = (await ensureOrganizationForUser(owner.id)).id;
    outsiderOrganizationId = (await ensureOrganizationForUser(outsider.id)).id;

    groupId = await insertGroup(organizationId, owner.id, "Engineering");
    await addMember(owner.id, groupId, true);
    await addMember(member.id, groupId);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("who counts as an admin", () => {
    it("treats the owner as an admin without storing a row", async () => {
      expect(await isOrganizationAdmin(owner.id, organizationId)).toBe(true);

      const rows = await db.select().from(organizationUsers);
      expect(rows.some((row) => row.userId === owner.id)).toBe(false);
    });

    it("does not treat a group member as an org admin", async () => {
      expect(await isOrganizationAdmin(member.id, organizationId)).toBe(false);
    });

    it("does not leak across organizations", async () => {
      expect(await isOrganizationAdmin(owner.id, outsiderOrganizationId)).toBe(false);
      expect(await isOrganizationAdmin(outsider.id, organizationId)).toBe(false);
    });
  });

  describe("granting and revoking", () => {
    it("grants, revokes and re-grants without piling up rows", async () => {
      await grantOrganizationAdmin({
        organizationId,
        userId: delegate.id,
        grantedByUserId: owner.id,
      });
      expect(await isOrganizationAdmin(delegate.id, organizationId)).toBe(true);

      expect(await removeOrganizationAdmin(organizationId, delegate.id)).toBe(true);
      expect(await isOrganizationAdmin(delegate.id, organizationId)).toBe(false);

      await grantOrganizationAdmin({
        organizationId,
        userId: delegate.id,
        grantedByUserId: owner.id,
      });
      expect(await isOrganizationAdmin(delegate.id, organizationId)).toBe(true);

      const rows = await db.select().from(organizationUsers);
      expect(rows.filter((row) => row.userId === delegate.id)).toHaveLength(1);
    });

    it("reports revoking a non-admin rather than silently succeeding", async () => {
      expect(await removeOrganizationAdmin(organizationId, member.id)).toBe(false);
    });

    it("lists the owner first, then delegated admins", async () => {
      const admins = await listOrganizationAdmins(organizationId);

      expect(admins[0]?.userId).toBe(owner.id);
      expect(admins[0]?.isOwner).toBe(true);
      expect(admins.filter((admin) => admin.userId === owner.id)).toHaveLength(1);
      expect(admins.some((admin) => admin.userId === delegate.id && !admin.isOwner)).toBe(true);
    });
  });

  describe("candidates", () => {
    it("offers the org's group members and excludes existing admins", async () => {
      const candidates = await listOrganizationAdminCandidates(organizationId);
      const ids = candidates.map((candidate) => candidate.userId);

      expect(ids).toContain(member.id);
      expect(ids).not.toContain(owner.id);
      // Already an admin from the grant suite above.
      expect(ids).not.toContain(delegate.id);
      // Never in any of this organization's groups.
      expect(ids).not.toContain(outsider.id);
    });

    it("names the groups each candidate belongs to", async () => {
      const candidates = await listOrganizationAdminCandidates(organizationId);
      const candidate = candidates.find((row) => row.userId === member.id);

      expect(candidate?.groupNames).toEqual(["Engineering"]);
    });
  });

  describe("group access", () => {
    it("lets an org admin view and administer a group they do not belong to", async () => {
      expect(await validateUserGroupAccess(delegate.id, groupId)).toBe(true);
      expect(await resolveGroupAdmin(delegate.id, groupId)).toEqual({
        canAdmin: true,
        viaOrgAdmin: true,
      });
    });

    it("marks a group admin's own membership as not coming from the org", async () => {
      expect(await resolveGroupAdmin(owner.id, groupId)).toEqual({
        canAdmin: true,
        viaOrgAdmin: false,
      });
    });

    it("keeps a plain member out of administration", async () => {
      expect(await validateUserGroupAccess(member.id, groupId)).toBe(true);
      expect(await resolveGroupAdmin(member.id, groupId)).toEqual({
        canAdmin: false,
        viaOrgAdmin: false,
      });
    });

    it("gives an org admin no access to another organization's group", async () => {
      const foreignGroupId = await insertGroup(
        outsiderOrganizationId,
        outsider.id,
        "Other Company"
      );

      expect(await validateUserGroupAccess(delegate.id, foreignGroupId)).toBe(false);
      expect(await resolveGroupAdmin(delegate.id, foreignGroupId)).toEqual({
        canAdmin: false,
        viaOrgAdmin: false,
      });
    });

    it("grants no approver rights", async () => {
      // The whole point of the boundary: administering a team is not the same
      // as being allowed to decide its members' leave.
      expect(await getGroupsWhereUserCanApprove([groupId], delegate.id)).toEqual([]);
    });

    it("counts the org's groups as administrable, membership aside", async () => {
      expect(await getAdministrableGroupIds(delegate.id)).toContain(groupId);
      expect(await getAdministrableGroupIds(member.id)).not.toContain(groupId);
    });

    it("stops reaching the group once the grant is revoked", async () => {
      await removeOrganizationAdmin(organizationId, delegate.id);

      expect(await validateUserGroupAccess(delegate.id, groupId)).toBe(false);
      expect(await resolveGroupAdmin(delegate.id, groupId)).toEqual({
        canAdmin: false,
        viaOrgAdmin: false,
      });

      await grantOrganizationAdmin({
        organizationId,
        userId: delegate.id,
        grantedByUserId: owner.id,
      });
    });
  });

  describe("organization badge", () => {
    it("reports a free organization as inactive", async () => {
      const badges = await resolveOrganizationBadges([organizationId]);

      expect(badges.get(organizationId)).toMatchObject({
        id: organizationId,
        plan: "FREE",
        status: null,
        active: false,
      });
    });

    it("reports an active paid subscription", async () => {
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
      });

      const badges = await resolveOrganizationBadges([organizationId]);

      expect(badges.get(organizationId)).toMatchObject({
        plan: "PRO",
        status: subscriptionStatus.Active,
        active: true,
      });
    });

    it("reports a lapsed subscription past its grace as inactive", async () => {
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.PastDue,
        graceEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      const badge = (await resolveOrganizationBadges([organizationId])).get(organizationId);

      expect(badge?.active).toBe(false);
      // The plan drops to Free once grace expires, which is what the badge
      // must show — claiming Pro would promise limits the guards no longer give.
      expect(badge?.plan).toBe("FREE");
    });

    it("derives sickDayBenefitActive from the toggle and a paid plan", async () => {
      const badgeFor = async () =>
        (await resolveOrganizationBadges([organizationId])).get(organizationId);

      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
      });
      expect((await badgeFor())?.sickDayBenefitActive).toBe(false);

      await updateOrganization(organizationId, { sickDayBenefitEnabled: true });
      expect((await badgeFor())?.sickDayBenefitActive).toBe(true);

      // A lapse makes the benefit dormant without touching the stored toggle.
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.PastDue,
        graceEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      expect((await badgeFor())?.sickDayBenefitActive).toBe(false);

      await updateOrganization(organizationId, { sickDayBenefitEnabled: false });
    });

    it("resolves several organizations in one pass", async () => {
      const badges = await resolveOrganizationBadges([organizationId, outsiderOrganizationId]);

      expect(badges.size).toBe(2);
      expect(badges.get(outsiderOrganizationId)?.plan).toBe("FREE");
    });
  });
});
