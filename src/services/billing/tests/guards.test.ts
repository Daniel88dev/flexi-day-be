import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSubscription,
  mockGetGroup,
  mockGetAllGroups,
  mockCountGroups,
  mockOrderedGroupIds,
  mockCountMembers,
  mockCountInvites,
  mockLockOrganization,
  mockGetOrganizationById,
} = vi.hoisted(() => ({
  mockGetSubscription: vi.fn(),
  mockGetGroup: vi.fn(),
  mockGetAllGroups: vi.fn(),
  mockCountGroups: vi.fn(),
  mockOrderedGroupIds: vi.fn(),
  mockCountMembers: vi.fn(),
  mockCountInvites: vi.fn(),
  mockLockOrganization: vi.fn(),
  mockGetOrganizationById: vi.fn(),
}));

vi.mock("../subscriptionServices.js", () => ({
  getSubscriptionForOrganization: mockGetSubscription,
}));

vi.mock("../../group/groupServices.js", () => ({
  getGroup: mockGetGroup,
  getAllGroups: mockGetAllGroups,
  countLiveGroupsForOrganization: mockCountGroups,
  getLiveGroupIdsForOrganizationOrdered: mockOrderedGroupIds,
}));

vi.mock("../../groupUser/groupUserServices.js", () => ({
  countActiveMembersInGroup: mockCountMembers,
}));

vi.mock("../../groupUser/inviteLinkServices.js", () => ({
  countOpenInvitesForGroup: mockCountInvites,
}));

vi.mock("../../organization/organizationServices.js", () => ({
  lockOrganization: mockLockOrganization,
  getOrganizationById: mockGetOrganizationById,
}));

import {
  assertCanAddMember,
  assertCanCreateGroup,
  assertCanEnableSickDayBenefit,
  assertGroupsWritable,
  assertGroupWritable,
  assertSickDayRequestable,
} from "../guards.js";
import { subscriptionPlan, subscriptionStatus } from "../../../db/schema/subscription-schema.js";

const GROUP = { id: "group-1", organizationId: "org-1" };

const lapsedProSub = {
  plan: subscriptionPlan.Pro,
  status: subscriptionStatus.Canceled,
  extraGroupSlots: 0,
  graceEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  manualPlanOverride: null,
  manualPlanUntil: null,
  manualMaxGroups: null,
  manualMaxMembersPerGroup: null,
};

describe("assertCanCreateGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSubscription.mockResolvedValue(undefined);
  });

  it("allows creation below the Free group limit", async () => {
    mockCountGroups.mockResolvedValue(2);
    await expect(assertCanCreateGroup("org-1")).resolves.toBeUndefined();
  });

  it("402s with PLAN_LIMIT context at the Free group limit", async () => {
    mockCountGroups.mockResolvedValue(3);
    await expect(assertCanCreateGroup("org-1")).rejects.toMatchObject({
      code: 402,
      errors: [
        expect.objectContaining({ publicContext: { reason: "PLAN_LIMIT", limit: 3, current: 3 } }),
      ],
    });
  });

  it("row-locks the organization when running inside a transaction", async () => {
    mockCountGroups.mockResolvedValue(0);
    const tx = {} as never;

    await assertCanCreateGroup("org-1", tx);

    // Without the lock, parallel creates all read the same pre-insert count.
    expect(mockLockOrganization).toHaveBeenCalledWith("org-1", tx);
  });

  it("does not attempt a lock outside a transaction", async () => {
    mockCountGroups.mockResolvedValue(0);
    await assertCanCreateGroup("org-1");
    expect(mockLockOrganization).not.toHaveBeenCalled();
  });

  it("uses paid limits plus extra slots when subscribed", async () => {
    mockGetSubscription.mockResolvedValue({
      ...lapsedProSub,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
      extraGroupSlots: 2,
    });
    mockCountGroups.mockResolvedValue(6);
    await expect(assertCanCreateGroup("org-1")).resolves.toBeUndefined();

    mockCountGroups.mockResolvedValue(7);
    await expect(assertCanCreateGroup("org-1")).rejects.toMatchObject({ code: 402 });
  });
});

describe("assertCanAddMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSubscription.mockResolvedValue(undefined);
    mockGetGroup.mockResolvedValue(GROUP);
    mockCountInvites.mockResolvedValue(0);
  });

  it("404s when the group does not exist", async () => {
    mockGetGroup.mockResolvedValue(undefined);
    await expect(assertCanAddMember("nope")).rejects.toMatchObject({ code: 404 });
  });

  it("allows adding below the Free member limit", async () => {
    mockCountMembers.mockResolvedValue(9);
    await expect(assertCanAddMember("group-1")).resolves.toBeUndefined();
  });

  it("counts open invites against the cap", async () => {
    mockCountMembers.mockResolvedValue(9);
    mockCountInvites.mockResolvedValue(1);
    await expect(assertCanAddMember("group-1")).rejects.toMatchObject({
      code: 402,
      errors: [
        expect.objectContaining({
          publicContext: { reason: "PLAN_LIMIT", limit: 10, current: 10 },
        }),
      ],
    });
  });

  it("does not count the invite being redeemed against its own seat", async () => {
    mockCountMembers.mockResolvedValue(9);
    mockCountInvites.mockResolvedValue(1);
    await expect(
      assertCanAddMember("group-1", undefined, { redeemingOpenInvite: true })
    ).resolves.toBeUndefined();
  });
});

describe("assertGroupWritable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGroup.mockResolvedValue(GROUP);
    mockCountMembers.mockResolvedValue(5);
  });

  it("passes untouched while entitlements are writable", async () => {
    mockGetSubscription.mockResolvedValue(undefined);
    await expect(assertGroupWritable("group-1")).resolves.toBeUndefined();
    expect(mockOrderedGroupIds).not.toHaveBeenCalled();
  });

  it("locks groups beyond the oldest N once grace has expired", async () => {
    mockGetSubscription.mockResolvedValue(lapsedProSub);
    mockOrderedGroupIds.mockResolvedValue(["old-1", "old-2", "old-3", "group-1", "new-2"]);
    await expect(assertGroupWritable("group-1")).rejects.toMatchObject({
      code: 402,
      errors: [
        expect.objectContaining({ publicContext: { reason: "READ_ONLY", limit: 3, current: 5 } }),
      ],
    });
  });

  it("keeps the oldest N groups writable after lapse", async () => {
    mockGetSubscription.mockResolvedValue(lapsedProSub);
    mockOrderedGroupIds.mockResolvedValue(["group-1", "new-1", "new-2", "new-3"]);
    await expect(assertGroupWritable("group-1")).resolves.toBeUndefined();
  });

  it("locks a surviving group whose headcount exceeds the Free cap", async () => {
    mockGetSubscription.mockResolvedValue(lapsedProSub);
    mockOrderedGroupIds.mockResolvedValue(["group-1"]);
    mockCountMembers.mockResolvedValue(12);
    await expect(assertGroupWritable("group-1")).rejects.toMatchObject({
      code: 402,
      errors: [
        expect.objectContaining({ publicContext: { reason: "READ_ONLY", limit: 10, current: 12 } }),
      ],
    });
  });
});

describe("assertGroupsWritable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCountMembers.mockResolvedValue(1);
  });

  it("resolves each organization's entitlements once, not once per group", async () => {
    mockGetSubscription.mockResolvedValue(undefined);
    mockGetAllGroups.mockResolvedValue([
      { id: "group-1", organizationId: "org-1" },
      { id: "group-2", organizationId: "org-1" },
      { id: "group-3", organizationId: "org-1" },
    ]);

    await assertGroupsWritable(["group-1", "group-2", "group-3", "group-1"]);

    expect(mockGetAllGroups).toHaveBeenCalledTimes(1);
    expect(mockGetSubscription).toHaveBeenCalledTimes(1);
    // Writable orgs never need the ordering query.
    expect(mockOrderedGroupIds).not.toHaveBeenCalled();
  });

  it("404s when one of the ids is not a live group", async () => {
    mockGetSubscription.mockResolvedValue(undefined);
    mockGetAllGroups.mockResolvedValue([{ id: "group-1", organizationId: "org-1" }]);

    await expect(assertGroupsWritable(["group-1", "ghost"])).rejects.toMatchObject({ code: 404 });
  });

  it("locks the over-limit group in a lapsed batch", async () => {
    mockGetSubscription.mockResolvedValue(lapsedProSub);
    mockGetAllGroups.mockResolvedValue([
      { id: "old-1", organizationId: "org-1" },
      { id: "group-9", organizationId: "org-1" },
    ]);
    mockOrderedGroupIds.mockResolvedValue(["old-1", "old-2", "old-3", "group-9"]);

    await expect(assertGroupsWritable(["old-1", "group-9"])).rejects.toMatchObject({
      code: 402,
      errors: [
        expect.objectContaining({
          publicContext: expect.objectContaining({ reason: "READ_ONLY" }),
        }),
      ],
    });
  });

  it("returns immediately for an empty batch", async () => {
    await assertGroupsWritable([]);
    expect(mockGetAllGroups).not.toHaveBeenCalled();
  });
});

describe("assertCanEnableSickDayBenefit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("402s on the Free plan", async () => {
    mockGetSubscription.mockResolvedValue(undefined);

    await expect(assertCanEnableSickDayBenefit("org-1")).rejects.toMatchObject({
      code: 402,
      errors: [expect.objectContaining({ publicContext: { reason: "PLAN_LIMIT" } })],
    });
  });

  it("allows an active paid subscription", async () => {
    mockGetSubscription.mockResolvedValue({
      ...lapsedProSub,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });

    await expect(assertCanEnableSickDayBenefit("org-1")).resolves.toBeUndefined();
  });

  it("402s once a lapsed subscription's grace has expired", async () => {
    mockGetSubscription.mockResolvedValue(lapsedProSub);

    await expect(assertCanEnableSickDayBenefit("org-1")).rejects.toMatchObject({ code: 402 });
  });
});

describe("assertSickDayRequestable", () => {
  const enabledOrg = { id: "org-1", sickDayBenefitEnabled: true };
  const activeProSub = { ...lapsedProSub, status: subscriptionStatus.Active, graceEndsAt: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGroup.mockResolvedValue(GROUP);
  });

  it("404s when the group does not exist", async () => {
    mockGetGroup.mockResolvedValue(undefined);
    await expect(assertSickDayRequestable("nope")).rejects.toMatchObject({ code: 404 });
  });

  it("422s when the organization has the benefit switched off", async () => {
    mockGetOrganizationById.mockResolvedValue({ id: "org-1", sickDayBenefitEnabled: false });
    mockGetSubscription.mockResolvedValue(activeProSub);

    await expect(assertSickDayRequestable("group-1")).rejects.toMatchObject({ code: 422 });
  });

  it("allows a member of an enabled organization on an active paid plan", async () => {
    mockGetOrganizationById.mockResolvedValue(enabledOrg);
    mockGetSubscription.mockResolvedValue(activeProSub);

    await expect(assertSickDayRequestable("group-1")).resolves.toBeUndefined();
  });

  it("stays available through the grace window", async () => {
    mockGetOrganizationById.mockResolvedValue(enabledOrg);
    mockGetSubscription.mockResolvedValue({
      ...lapsedProSub,
      graceEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await expect(assertSickDayRequestable("group-1")).resolves.toBeUndefined();
  });

  it("goes dormant once the lapsed subscription's grace has expired", async () => {
    // The toggle survives the lapse — only requestability is withdrawn, so
    // re-subscribing restores the benefit without touching any data.
    mockGetOrganizationById.mockResolvedValue(enabledOrg);
    mockGetSubscription.mockResolvedValue(lapsedProSub);

    await expect(assertSickDayRequestable("group-1")).rejects.toMatchObject({ code: 422 });
  });
});
