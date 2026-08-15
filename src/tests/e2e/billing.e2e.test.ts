import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import {
  subscriptionPlan,
  subscriptionStatus,
  manualPlanOverride,
} from "../../db/schema/subscription-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import {
  recordPaddleEvent,
  upsertSubscription,
} from "../../services/billing/subscriptionServices.js";
import {
  assertCanAddMember,
  assertCanCreateGroup,
  assertGroupWritable,
} from "../../services/billing/guards.js";

/**
 * The plan-limit guards live in SQL counts plus the pure resolver; this suite
 * verifies the whole stack against a real database.
 */
describe("billing limits", () => {
  let owner: { id: string };
  let member: { id: string };

  const insertGroup = async (organizationId: string, name: string, createdAt: Date) => {
    const id = uuidv4();
    await db.insert(groups).values({
      id,
      organizationId,
      groupName: name,
      managerUserId: owner.id,
      createdAt,
      updatedAt: createdAt,
    });
    return id;
  };

  const addMember = (userId: string, groupId: string) =>
    db.insert(groupUsers).values({
      id: uuidv4(),
      userId,
      groupId,
      viewAccess: true,
      adminAccess: false,
      controlledUser: true,
    });

  const addOpenInvite = (groupId: string, email: string) =>
    db.insert(inviteLink).values({
      id: uuidv4(),
      groupId,
      code: `CODE-${uuidv4().slice(0, 8)}`,
      email,
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

  beforeAll(async () => {
    await cleanupTestData();
    owner = await createTestUser("billing-owner@test.com", "Billing Owner", "password123");
    member = await createTestUser("billing-member@test.com", "Billing Member", "password123");
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("creates exactly one organization per user, however often it is asked", async () => {
    const first = await ensureOrganizationForUser(owner.id);
    const second = await ensureOrganizationForUser(owner.id);
    expect(second.id).toBe(first.id);
    expect(first.ownerUserId).toBe(owner.id);
    expect(first.billingEmail).toBe("billing-owner@test.com");
  });

  it("blocks the fourth group on the Free plan with a 402", async () => {
    const organization = await ensureOrganizationForUser(owner.id);
    const base = Date.now();
    await insertGroup(organization.id, "Free 1", new Date(base - 4000));
    await insertGroup(organization.id, "Free 2", new Date(base - 3000));
    await insertGroup(organization.id, "Free 3", new Date(base - 2000));

    await expect(assertCanCreateGroup(organization.id)).rejects.toMatchObject({
      code: 402,
      errors: [
        expect.objectContaining({
          publicContext: { reason: "PLAN_LIMIT", limit: 3, current: 3 },
        }),
      ],
    });
  });

  it("lifts the cap when a Pro subscription with slots is active", async () => {
    const organization = await ensureOrganizationForUser(owner.id);
    await upsertSubscription(organization.id, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      extraGroupSlots: 1,
    });

    await expect(assertCanCreateGroup(organization.id)).resolves.toBeUndefined();
  });

  it("counts live members plus open invites against the member cap", async () => {
    const organization = await ensureOrganizationForUser(owner.id);
    // CUSTOM override with a 2-person cap keeps the fixture small.
    await upsertSubscription(organization.id, {
      manualPlanOverride: manualPlanOverride.Custom,
      manualMaxGroups: 10,
      manualMaxMembersPerGroup: 2,
    });

    const groupId = await insertGroup(organization.id, "Capped", new Date());
    await addMember(owner.id, groupId);

    await expect(assertCanAddMember(groupId)).resolves.toBeUndefined();

    await addOpenInvite(groupId, "pending@test.com");
    await expect(assertCanAddMember(groupId)).rejects.toMatchObject({ code: 402 });

    // The redemption path must not count the invite being redeemed.
    await expect(
      assertCanAddMember(groupId, undefined, { redeemingOpenInvite: true })
    ).resolves.toBeUndefined();
  });

  it("locks only the newest groups once grace has expired", async () => {
    const organization = await ensureOrganizationForUser(owner.id);
    await upsertSubscription(organization.id, {
      manualPlanOverride: null,
      manualMaxGroups: null,
      manualMaxMembersPerGroup: null,
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Canceled,
      extraGroupSlots: 0,
      graceEndsAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const groupIds = await db.select({ id: groups.id, createdAt: groups.createdAt }).from(groups);
    const sorted = groupIds.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Free allows 3 groups: the three oldest stay writable, the rest lock.
    await expect(assertGroupWritable(sorted[0]!.id)).resolves.toBeUndefined();
    await expect(assertGroupWritable(sorted[sorted.length - 1]!.id)).rejects.toMatchObject({
      code: 402,
      errors: [
        expect.objectContaining({
          publicContext: expect.objectContaining({ reason: "READ_ONLY" }),
        }),
      ],
    });
  });

  it("keeps paid limits writable inside the grace window", async () => {
    const organization = await ensureOrganizationForUser(owner.id);
    await upsertSubscription(organization.id, {
      status: subscriptionStatus.PastDue,
      graceEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const [anyGroup] = await db.select({ id: groups.id }).from(groups).limit(1);
    await expect(assertGroupWritable(anyGroup!.id)).resolves.toBeUndefined();
  });

  it("records each Paddle event id exactly once", async () => {
    const eventId = `evt-${uuidv4()}`;
    expect(await recordPaddleEvent(eventId, "subscription.updated")).toBe(true);
    expect(await recordPaddleEvent(eventId, "subscription.updated")).toBe(false);
  });

  it("grants a member no organization until they create a group", async () => {
    const { getOrganizationForOwner } =
      await import("../../services/organization/organizationServices.js");
    expect(await getOrganizationForOwner(member.id)).toBeUndefined();
  });
});
