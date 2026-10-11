import { describe, it, expect, vi, beforeEach } from "vitest";

const { memberships, groupRows, organizationRows, subscriptionRows } = vi.hoisted(() => ({
  memberships: { value: [] as { groupId: string }[] },
  groupRows: { value: [] as { id: string; organizationId: string }[] },
  organizationRows: { value: [] as unknown[] },
  subscriptionRows: { value: [] as unknown[] },
}));

vi.mock("../../groupUser/groupUserServices.js", () => ({
  getAllGroupsForUser: vi.fn(async () => memberships.value),
}));
vi.mock("../../group/groupServices.js", () => ({
  getAllGroups: vi.fn(async (ids: string[]) =>
    groupRows.value.filter((group) => ids.includes(group.id))
  ),
}));
vi.mock("../../organization/organizationServices.js", () => ({
  getOrganizationsByIds: vi.fn(async () => organizationRows.value),
}));
vi.mock("../../billing/subscriptionServices.js", () => ({
  getSubscriptionsForOrganizations: vi.fn(async () => subscriptionRows.value),
}));

import {
  assertCalendarSyncEntitled,
  CALENDAR_SYNC_PLAN_REQUIRED,
  isCalendarSyncEntitled,
} from "../entitlement.js";
import { subscriptionPlan, subscriptionStatus } from "../../../db/schema/subscription-schema.js";
import AppError from "../../../utils/appError.js";

const USER_ID = "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b";
const DAY_MS = 24 * 60 * 60 * 1000;

const organization = (id: string) => ({ id, name: id, sickDayBenefitEnabled: false });

const subscription = (
  organizationId: string,
  status: subscriptionStatus,
  graceEndsAt: Date | null = null
) => ({
  id: `sub-${organizationId}`,
  organizationId,
  paddleSubscriptionId: null,
  paddleCustomerId: null,
  plan: subscriptionPlan.Pro,
  status,
  billingCycle: null,
  extraGroupSlots: 0,
  currentPeriodEnd: null,
  graceEndsAt,
  cancelAt: null,
  manualPlanOverride: null,
  manualMaxGroups: null,
  manualMaxMembersPerGroup: null,
  manualPlanUntil: null,
  lastEventAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const memberOf = (...groups: [groupId: string, organizationId: string][]) => {
  memberships.value = groups.map(([groupId]) => ({ groupId }));
  groupRows.value = groups.map(([id, organizationId]) => ({ id, organizationId }));
  organizationRows.value = [...new Set(groups.map(([, org]) => org))].map(organization);
};

describe("calendar sync entitlement", () => {
  beforeEach(() => {
    memberships.value = [];
    groupRows.value = [];
    organizationRows.value = [];
    subscriptionRows.value = [];
  });

  it("is off for a user in no group", async () => {
    expect(await isCalendarSyncEntitled(USER_ID)).toBe(false);
  });

  it("is off when every covering organization is on Free", async () => {
    memberOf(["group-a", "org-a"]);

    expect(await isCalendarSyncEntitled(USER_ID)).toBe(false);
  });

  it("is on when any covering organization has an active paid plan", async () => {
    memberOf(["group-a", "org-free"], ["group-b", "org-pro"]);
    subscriptionRows.value = [subscription("org-pro", subscriptionStatus.Active)];

    expect(await isCalendarSyncEntitled(USER_ID)).toBe(true);
  });

  it("stays on through a lapsed plan's grace", async () => {
    memberOf(["group-a", "org-a"]);
    subscriptionRows.value = [
      subscription("org-a", subscriptionStatus.PastDue, new Date(Date.now() + DAY_MS)),
    ];

    expect(await isCalendarSyncEntitled(USER_ID)).toBe(true);
  });

  it("is off once a lapsed plan's grace has run out", async () => {
    memberOf(["group-a", "org-a"]);
    subscriptionRows.value = [
      subscription("org-a", subscriptionStatus.Canceled, new Date(Date.now() - DAY_MS)),
    ];

    expect(await isCalendarSyncEntitled(USER_ID)).toBe(false);
  });

  it("refuses with a 402 the web can map", async () => {
    memberOf(["group-a", "org-a"]);

    let thrown: unknown;
    try {
      await assertCalendarSyncEntitled(USER_ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(402);
    expect((thrown as AppError).errors[0]?.publicContext).toEqual({
      reason: "PLAN_LIMIT",
      code: CALENDAR_SYNC_PLAN_REQUIRED,
    });
  });
});
