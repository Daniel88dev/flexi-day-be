import { beforeEach, describe, expect, it, vi } from "vitest";

const { scope, groupRows, subscriptionRows, birthdayRows, memberships } = vi.hoisted(() => ({
  scope: { value: [] as unknown[] },
  groupRows: { value: [] as { id: string; groupName: string; organizationId: string }[] },
  subscriptionRows: { value: [] as unknown[] },
  birthdayRows: { value: [] as unknown[] },
  memberships: { value: [] as { userId: string; groupId: string }[] },
}));

vi.mock("../../report/reportServices.js", () => ({
  getScopeEntries: vi.fn(async () => scope.value),
}));
vi.mock("../../group/groupServices.js", () => ({
  getAllGroups: vi.fn(async (ids: string[]) =>
    groupRows.value.filter((group) => ids.includes(group.id))
  ),
}));
vi.mock("../../billing/subscriptionServices.js", () => ({
  getSubscriptionsForOrganizations: vi.fn(async () => subscriptionRows.value),
}));
vi.mock("../birthdayServices.js", () => ({
  getBirthday: vi.fn(
    async (userId: string) =>
      (birthdayRows.value as { userId: string }[]).find((row) => row.userId === userId) ?? null
  ),
  getMemberBirthdaysInGroups: vi.fn(async (groupIds: string[]) => {
    const members = new Set(
      memberships.value.filter((m) => groupIds.includes(m.groupId)).map((m) => m.userId)
    );
    return (birthdayRows.value as { userId: string }[]).filter((row) => members.has(row.userId));
  }),
}));

import { canShareBirthday, getShareGroups, visibleBirthdays } from "../birthdayVisibility.js";
import {
  manualPlanOverride,
  subscriptionPlan,
  subscriptionStatus,
} from "../../../db/schema/subscription-schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const VIEWER = "viewerid0000000000000000000000ab";
const COLLEAGUE = "colleagueid000000000000000000abc";

const subscription = (organizationId: string, patch: Record<string, unknown>) => ({
  id: `sub-${organizationId}`,
  organizationId,
  paddleSubscriptionId: null,
  paddleCustomerId: null,
  plan: null,
  status: null,
  billingCycle: null,
  extraGroupSlots: 0,
  currentPeriodEnd: null,
  graceEndsAt: null,
  cancelAt: null,
  manualPlanOverride: null,
  manualMaxGroups: null,
  manualMaxMembersPerGroup: null,
  manualPlanUntil: null,
  lastEventAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...patch,
});

const paid = (org: string) =>
  subscription(org, { plan: subscriptionPlan.Pro, status: subscriptionStatus.Active });
const lapsedPastGrace = (org: string) =>
  subscription(org, {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Canceled,
    graceEndsAt: new Date(Date.now() - DAY_MS),
  });

const birthday = (userId: string, patch: Record<string, unknown> = {}) => ({
  userId,
  month: 5,
  day: 14,
  year: 1990,
  shared: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  ...patch,
});

/** The viewer sees `groupId` in full; the colleague is a member of it. */
const sharedGroup = (groupId: string, organizationId: string) => {
  scope.value.push({ groupId, groupName: groupId, access: "all", canEditQuotas: false });
  groupRows.value.push({ id: groupId, groupName: groupId, organizationId });
  memberships.value.push({ userId: COLLEAGUE, groupId }, { userId: VIEWER, groupId });
};

const ids = (rows: { userId: string }[]) => rows.map((row) => row.userId);

describe("visibleBirthdays", () => {
  beforeEach(() => {
    scope.value = [];
    groupRows.value = [];
    subscriptionRows.value = [];
    birthdayRows.value = [];
    memberships.value = [];
  });

  it("always holds the viewer's own birthday, shared or not, in no group at all", async () => {
    birthdayRows.value = [birthday(VIEWER, { shared: false })];

    expect(ids(await visibleBirthdays(VIEWER))).toEqual([VIEWER]);
  });

  it("holds a colleague's shared birthday in a paid group", async () => {
    sharedGroup("group-a", "org-a");
    subscriptionRows.value = [paid("org-a")];
    birthdayRows.value = [birthday(COLLEAGUE)];

    expect(ids(await visibleBirthdays(VIEWER))).toEqual([COLLEAGUE]);
  });

  it("holds a colleague's shared birthday in a lapsed group", async () => {
    sharedGroup("group-a", "org-a");
    subscriptionRows.value = [lapsedPastGrace("org-a")];
    birthdayRows.value = [birthday(COLLEAGUE)];

    expect(ids(await visibleBirthdays(VIEWER))).toEqual([COLLEAGUE]);
  });

  it("holds it under a Free override, which is a lapse too", async () => {
    sharedGroup("group-a", "org-a");
    subscriptionRows.value = [
      subscription("org-a", { manualPlanOverride: manualPlanOverride.Free }),
    ];
    birthdayRows.value = [birthday(COLLEAGUE)];

    expect(ids(await visibleBirthdays(VIEWER))).toEqual([COLLEAGUE]);
  });

  it("never holds it in a group that never paid, with or without a subscription row", async () => {
    sharedGroup("group-a", "org-none");
    sharedGroup("group-b", "org-checkout");
    subscriptionRows.value = [subscription("org-checkout", {})];
    birthdayRows.value = [birthday(COLLEAGUE)];

    expect(await visibleBirthdays(VIEWER)).toEqual([]);
  });

  it("drops the colleague once they stop sharing", async () => {
    sharedGroup("group-a", "org-a");
    subscriptionRows.value = [paid("org-a")];
    birthdayRows.value = [birthday(COLLEAGUE, { shared: false })];

    expect(await visibleBirthdays(VIEWER)).toEqual([]);
  });

  it("never reads a group the viewer sees only their own records in", async () => {
    sharedGroup("group-a", "org-a");
    scope.value = [
      { groupId: "group-a", groupName: "group-a", access: "self", canEditQuotas: false },
    ];
    subscriptionRows.value = [paid("org-a")];
    birthdayRows.value = [birthday(COLLEAGUE)];

    expect(await visibleBirthdays(VIEWER)).toEqual([]);
  });

  it("narrows to one group, keeping the viewer's own", async () => {
    sharedGroup("group-a", "org-a");
    groupRows.value.push({ id: "group-b", groupName: "group-b", organizationId: "org-a" });
    scope.value.push({
      groupId: "group-b",
      groupName: "group-b",
      access: "all",
      canEditQuotas: false,
    });
    subscriptionRows.value = [paid("org-a")];
    birthdayRows.value = [birthday(VIEWER, { shared: false }), birthday(COLLEAGUE)];

    expect(ids(await visibleBirthdays(VIEWER, "group-b"))).toEqual([VIEWER]);
    expect(ids(await visibleBirthdays(VIEWER, "group-a"))).toEqual([VIEWER, COLLEAGUE]);
  });

  it("lists a colleague in two visible groups once", async () => {
    sharedGroup("group-a", "org-a");
    sharedGroup("group-b", "org-a");
    subscriptionRows.value = [paid("org-a")];
    birthdayRows.value = [birthday(COLLEAGUE)];

    expect(ids(await visibleBirthdays(VIEWER))).toEqual([COLLEAGUE]);
  });

  it("never holds a removed birthday, the viewer's own included", async () => {
    sharedGroup("group-a", "org-a");
    subscriptionRows.value = [paid("org-a")];
    const removed = { month: null, day: null, year: null, shared: false, deletedAt: new Date() };
    birthdayRows.value = [birthday(VIEWER, removed), birthday(COLLEAGUE, removed)];

    expect(await visibleBirthdays(VIEWER)).toEqual([]);
  });
});

describe("canShareBirthday and share groups", () => {
  beforeEach(() => {
    scope.value = [];
    groupRows.value = [];
    subscriptionRows.value = [];
  });

  const memberOf = (groupId: string, organizationId: string, access: "all" | "self" = "self") => {
    scope.value.push({ groupId, groupName: `Team ${groupId}`, access, canEditQuotas: false });
    groupRows.value.push({ id: groupId, groupName: `Team ${groupId}`, organizationId });
  };

  it("cannot share in no group at all", async () => {
    expect(await canShareBirthday(VIEWER)).toBe(false);
    expect(await getShareGroups(VIEWER)).toEqual([]);
  });

  it("can share while any group's organization is paid, grace included", async () => {
    memberOf("a", "org-free");
    memberOf("b", "org-grace");
    subscriptionRows.value = [
      subscription("org-grace", {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.PastDue,
        graceEndsAt: new Date(Date.now() + DAY_MS),
      }),
    ];

    expect(await canShareBirthday(VIEWER)).toBe(true);
  });

  it("cannot share once every paid group has lapsed, yet still reaches the lapsed ones", async () => {
    memberOf("a", "org-lapsed");
    memberOf("b", "org-free");
    subscriptionRows.value = [lapsedPastGrace("org-lapsed")];

    expect(await canShareBirthday(VIEWER)).toBe(false);
    expect(await getShareGroups(VIEWER)).toEqual([{ groupId: "a", groupName: "Team a" }]);
  });

  it("lists paid and lapsed groups, never a never-paid one, whatever the member's flags", async () => {
    memberOf("a", "org-paid", "self");
    memberOf("b", "org-lapsed", "all");
    memberOf("c", "org-free");
    subscriptionRows.value = [paid("org-paid"), lapsedPastGrace("org-lapsed")];

    expect(await getShareGroups(VIEWER)).toEqual([
      { groupId: "a", groupName: "Team a" },
      { groupId: "b", groupName: "Team b" },
    ]);
  });
});
