import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import {
  billingCycle,
  subscriptionPlan,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  ensureOrganizationForUser,
  getOrganizationForOwner,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";

/**
 * The billing overview resolves the organization the caller *administers*, not
 * only the one they own. A delegated admin who saw Free here was locked out of
 * every paid feature they administer, so each entitlement-bearing field is
 * asserted rather than just the plan name.
 */
describe("billing overview over the API", () => {
  let app: Express;

  let owner: { id: string };
  /** Delegated admin of the owner's organization, owning nothing themselves. */
  let delegate: { id: string };
  /** Owns a Free organization and is a delegate in the owner's Pro one. */
  let dualAdmin: { id: string };
  let outsider: { id: string };

  let ownerCookie: string;
  let delegateCookie: string;
  let dualAdminCookie: string;
  let outsiderCookie: string;

  let proOrganizationId: string;
  let freeOrganizationId: string;

  // `getGroupUsageForOrganization` sorts by createdAt, so the fixture stamps it
  // rather than letting two inserts race to the same microsecond.
  const insertGroup = async (
    organizationId: string,
    name: string,
    managerUserId: string,
    createdAt: Date
  ) => {
    const id = uuidv4();
    await db.insert(groups).values({
      id,
      organizationId,
      groupName: name,
      managerUserId,
      createdAt,
      updatedAt: createdAt,
    });
    return id;
  };

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    owner = await createTestUser("overview-owner@test.com", "Olivia Owner", "password123");
    delegate = await createTestUser("overview-delegate@test.com", "Dana Delegate", "password123");
    dualAdmin = await createTestUser("overview-dual@test.com", "Dex Dual", "password123");
    outsider = await createTestUser("overview-outsider@test.com", "Otto Outsider", "password123");

    proOrganizationId = (await ensureOrganizationForUser(owner.id)).id;
    freeOrganizationId = (await ensureOrganizationForUser(dualAdmin.id)).id;

    await upsertSubscription(proOrganizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      billingCycle: billingCycle.Yearly,
      paddleSubscriptionId: `sub_${uuidv4()}`,
      extraGroupSlots: 1,
    });

    const base = Date.now();
    const engineering = await insertGroup(
      proOrganizationId,
      "Engineering",
      owner.id,
      new Date(base - 2000)
    );
    await insertGroup(proOrganizationId, "Support", owner.id, new Date(base - 1000));
    await insertGroup(freeOrganizationId, "Dual's own team", dualAdmin.id, new Date(base));

    await db.insert(groupUsers).values({
      id: uuidv4(),
      userId: owner.id,
      groupId: engineering,
      viewAccess: true,
      adminAccess: true,
      controlledUser: true,
    });

    for (const userId of [delegate.id, dualAdmin.id]) {
      await grantOrganizationAdmin({
        organizationId: proOrganizationId,
        userId,
        grantedByUserId: owner.id,
      });
    }

    ownerCookie = await authCookieFor(owner.id);
    delegateCookie = await authCookieFor(delegate.id);
    dualAdminCookie = await authCookieFor(dualAdmin.id);
    outsiderCookie = await authCookieFor(outsider.id);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("gives a delegated admin the organization they administer", async () => {
    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Cookie", delegateCookie)
      .expect(200);

    expect(res.body.organization).toMatchObject({ id: proOrganizationId, name: "Olivia Owner" });
    expect(res.body.subscription).toMatchObject({
      plan: "PRO",
      status: subscriptionStatus.Active,
      extraGroupSlots: 1,
    });
    expect(res.body.entitlements).toMatchObject({
      plan: "PRO",
      // Pro's 5 groups plus the purchased slot.
      maxGroups: 6,
      maxMembersPerGroup: 25,
      writable: true,
    });
    expect(res.body.usage.groupsUsed).toBe(2);
    expect(res.body.usage.groups).toEqual([
      expect.objectContaining({ groupName: "Engineering", members: 1 }),
      expect.objectContaining({ groupName: "Support", members: 0 }),
    ]);
  });

  it("gives the owner the same plan, limits and usage as their delegate", async () => {
    const forOwner = await request(app)
      .get("/api/billing/subscription")
      .set("Cookie", ownerCookie)
      .expect(200);
    const forDelegate = await request(app)
      .get("/api/billing/subscription")
      .set("Cookie", delegateCookie)
      .expect(200);

    for (const key of ["subscription", "entitlements", "usage", "planLimits"]) {
      expect(forDelegate.body[key]).toEqual(forOwner.body[key]);
    }
    expect(forDelegate.body.organization.id).toBe(forOwner.body.organization.id);
  });

  it("keeps the billing address and the Paddle linkage owner-only", async () => {
    const forOwner = await request(app)
      .get("/api/billing/subscription")
      .set("Cookie", ownerCookie)
      .expect(200);
    const forDelegate = await request(app)
      .get("/api/billing/subscription")
      .set("Cookie", delegateCookie)
      .expect(200);

    expect(forOwner.body.organization).toMatchObject({
      isOwner: true,
      billingEmail: "overview-owner@test.com",
    });
    expect(forDelegate.body.organization).toMatchObject({
      isOwner: false,
      billingEmail: null,
      hasPaddleCustomer: false,
    });
  });

  it("gives someone who owns one organization their own, not the delegated one", async () => {
    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Cookie", dualAdminCookie)
      .expect(200);

    expect(res.body.organization).toMatchObject({ id: freeOrganizationId });
    expect(res.body.subscription).toBeNull();
    expect(res.body.entitlements).toMatchObject({ plan: "FREE", maxGroups: 3 });
    expect(res.body.usage.groupsUsed).toBe(1);
  });

  it("gives an unrelated user Free with empty usage", async () => {
    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Cookie", outsiderCookie)
      .expect(200);

    expect(res.body.organization).toBeNull();
    expect(res.body.subscription).toBeNull();
    expect(res.body.entitlements).toMatchObject({ plan: "FREE", maxGroups: 3, writable: true });
    expect(res.body.usage).toEqual({ groupsUsed: 0, groups: [] });
  });

  it("keeps billing writes owner-only", async () => {
    // Checkout, change-plan, slots and the portal all resolve their
    // organization with `getOrganizationForOwner`, and those routes stop at
    // `requirePaddle` in this environment. Asserting the resolver is what pins
    // the split: the delegate reads the Pro plan but owns nothing to charge.
    expect(await getOrganizationForOwner(delegate.id)).toBeUndefined();
    expect((await getOrganizationForOwner(owner.id))?.id).toBe(proOrganizationId);
  });
});
