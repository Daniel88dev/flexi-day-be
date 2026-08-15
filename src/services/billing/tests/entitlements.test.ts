import { describe, expect, test } from "vitest";
import { PLAN_LIMITS, resolveEntitlements } from "../entitlements.js";
import type { Subscription } from "../types.js";
import {
  billingCycle,
  manualPlanOverride,
  subscriptionPlan,
  subscriptionStatus,
} from "../../../db/schema/subscription-schema.js";

const NOW = new Date("2026-08-11T12:00:00Z");
const PAST = new Date("2026-08-01T12:00:00Z");
const FUTURE = new Date("2026-08-20T12:00:00Z");

const makeSub = (patch: Partial<Subscription>): Subscription => ({
  id: "sub-1",
  organizationId: "org-1",
  paddleSubscriptionId: "psub-1",
  paddleCustomerId: "pcus-1",
  plan: subscriptionPlan.Pro,
  status: subscriptionStatus.Active,
  billingCycle: billingCycle.Monthly,
  extraGroupSlots: 0,
  currentPeriodEnd: FUTURE,
  graceEndsAt: null,
  cancelAt: null,
  manualPlanOverride: null,
  manualMaxGroups: null,
  manualMaxMembersPerGroup: null,
  manualPlanUntil: null,
  lastEventAt: null,
  createdAt: PAST,
  updatedAt: PAST,
  ...patch,
});

describe("resolveEntitlements", () => {
  test("no row means Free limits, writable", () => {
    expect(resolveEntitlements(null, NOW)).toEqual({
      plan: "FREE",
      maxGroups: PLAN_LIMITS.FREE.groups,
      maxMembersPerGroup: PLAN_LIMITS.FREE.membersPerGroup,
      writable: true,
      graceEndsAt: null,
    });
  });

  describe("active / trialing", () => {
    test.each([subscriptionStatus.Active, subscriptionStatus.Trialing])(
      "%s PRO gives Pro limits",
      (status) => {
        const result = resolveEntitlements(makeSub({ status }), NOW);
        expect(result).toEqual({
          plan: "PRO",
          maxGroups: PLAN_LIMITS.PRO.groups,
          maxMembersPerGroup: PLAN_LIMITS.PRO.membersPerGroup,
          writable: true,
          graceEndsAt: null,
        });
      }
    );

    test("extra group slots add to maxGroups", () => {
      const result = resolveEntitlements(makeSub({ extraGroupSlots: 4 }), NOW);
      expect(result.maxGroups).toBe(PLAN_LIMITS.PRO.groups + 4);
    });

    test("negative extraGroupSlots never reduces the plan allowance", () => {
      const result = resolveEntitlements(makeSub({ extraGroupSlots: -2 }), NOW);
      expect(result.maxGroups).toBe(PLAN_LIMITS.PRO.groups);
    });

    test("slots are clamped to the plan ceiling even if Paddle reports more", () => {
      // A quantity edited straight in the Paddle dashboard bypasses the
      // checkout/slot routes, so the resolver has to hold the line.
      const result = resolveEntitlements(makeSub({ extraGroupSlots: 50 }), NOW);
      expect(result.maxGroups).toBe(PLAN_LIMITS.PRO.groups + PLAN_LIMITS.PRO.maxExtraSlots);
    });

    test("active ENTERPRISE gives Enterprise limits", () => {
      const result = resolveEntitlements(
        makeSub({ plan: subscriptionPlan.Enterprise, extraGroupSlots: 2 }),
        NOW
      );
      expect(result).toEqual({
        plan: "ENTERPRISE",
        maxGroups: PLAN_LIMITS.ENTERPRISE.groups + 2,
        maxMembersPerGroup: PLAN_LIMITS.ENTERPRISE.membersPerGroup,
        writable: true,
        graceEndsAt: null,
      });
    });

    test("grace timestamp left over from a recovered payment is not exposed", () => {
      const result = resolveEntitlements(makeSub({ graceEndsAt: FUTURE }), NOW);
      expect(result.graceEndsAt).toBeNull();
    });
  });

  describe("lapsed statuses", () => {
    const lapsed = [
      subscriptionStatus.PastDue,
      subscriptionStatus.Canceled,
      subscriptionStatus.Paused,
    ];

    test.each(lapsed)(
      "%s with future grace keeps paid limits and exposes graceEndsAt",
      (status) => {
        const result = resolveEntitlements(
          makeSub({ status, graceEndsAt: FUTURE, extraGroupSlots: 1 }),
          NOW
        );
        expect(result).toEqual({
          plan: "PRO",
          maxGroups: PLAN_LIMITS.PRO.groups + 1,
          maxMembersPerGroup: PLAN_LIMITS.PRO.membersPerGroup,
          writable: true,
          graceEndsAt: FUTURE.toISOString(),
        });
      }
    );

    test.each(lapsed)("%s with expired grace drops to Free and locks writes", (status) => {
      const result = resolveEntitlements(makeSub({ status, graceEndsAt: PAST }), NOW);
      expect(result).toEqual({
        plan: "FREE",
        maxGroups: PLAN_LIMITS.FREE.groups,
        maxMembersPerGroup: PLAN_LIMITS.FREE.membersPerGroup,
        writable: false,
        graceEndsAt: null,
      });
    });

    test.each(lapsed)("%s with no grace at all is treated as expired", (status) => {
      const result = resolveEntitlements(makeSub({ status, graceEndsAt: null }), NOW);
      expect(result.plan).toBe("FREE");
      expect(result.writable).toBe(false);
    });

    test("grace boundary: exactly now counts as expired", () => {
      const result = resolveEntitlements(
        makeSub({ status: subscriptionStatus.PastDue, graceEndsAt: NOW }),
        NOW
      );
      expect(result.writable).toBe(false);
    });
  });

  describe("manual override", () => {
    test("FREE override enforces Free limits read-only over the cap", () => {
      const result = resolveEntitlements(
        makeSub({ manualPlanOverride: manualPlanOverride.Free }),
        NOW
      );
      expect(result).toEqual({
        plan: "FREE",
        maxGroups: PLAN_LIMITS.FREE.groups,
        maxMembersPerGroup: PLAN_LIMITS.FREE.membersPerGroup,
        writable: false,
        graceEndsAt: null,
      });
    });

    test("PRO override wins over an expired subscription (grandfathering)", () => {
      const result = resolveEntitlements(
        makeSub({
          status: subscriptionStatus.Canceled,
          graceEndsAt: PAST,
          manualPlanOverride: manualPlanOverride.Pro,
        }),
        NOW
      );
      expect(result).toEqual({
        plan: "PRO",
        maxGroups: PLAN_LIMITS.PRO.groups,
        maxMembersPerGroup: PLAN_LIMITS.PRO.membersPerGroup,
        writable: true,
        graceEndsAt: null,
      });
    });

    test("ENTERPRISE override uses Enterprise limits", () => {
      const result = resolveEntitlements(
        makeSub({ manualPlanOverride: manualPlanOverride.Enterprise, plan: null, status: null }),
        NOW
      );
      expect(result.plan).toBe("ENTERPRISE");
      expect(result.maxGroups).toBe(PLAN_LIMITS.ENTERPRISE.groups);
    });

    test("manual limit columns override the plan defaults", () => {
      const result = resolveEntitlements(
        makeSub({
          manualPlanOverride: manualPlanOverride.Pro,
          manualMaxGroups: 7,
          manualMaxMembersPerGroup: 30,
        }),
        NOW
      );
      expect(result.maxGroups).toBe(7);
      expect(result.maxMembersPerGroup).toBe(30);
    });

    test("CUSTOM override uses the manual limits", () => {
      const result = resolveEntitlements(
        makeSub({
          manualPlanOverride: manualPlanOverride.Custom,
          manualMaxGroups: 50,
          manualMaxMembersPerGroup: 500,
        }),
        NOW
      );
      expect(result).toEqual({
        plan: "CUSTOM",
        maxGroups: 50,
        maxMembersPerGroup: 500,
        writable: true,
        graceEndsAt: null,
      });
    });

    test("CUSTOM without manual limits falls back to Enterprise limits", () => {
      const result = resolveEntitlements(
        makeSub({ manualPlanOverride: manualPlanOverride.Custom }),
        NOW
      );
      expect(result.maxGroups).toBe(PLAN_LIMITS.ENTERPRISE.groups);
      expect(result.maxMembersPerGroup).toBe(PLAN_LIMITS.ENTERPRISE.membersPerGroup);
    });

    test("override active while manualPlanUntil is in the future", () => {
      const result = resolveEntitlements(
        makeSub({
          status: subscriptionStatus.Canceled,
          manualPlanOverride: manualPlanOverride.Pro,
          manualPlanUntil: FUTURE,
        }),
        NOW
      );
      expect(result.plan).toBe("PRO");
      expect(result.writable).toBe(true);
    });

    test("expired manualPlanUntil falls through to subscription state", () => {
      const result = resolveEntitlements(
        makeSub({
          status: subscriptionStatus.Canceled,
          graceEndsAt: PAST,
          manualPlanOverride: manualPlanOverride.Pro,
          manualPlanUntil: PAST,
        }),
        NOW
      );
      expect(result.plan).toBe("FREE");
      expect(result.writable).toBe(false);
    });
  });

  test("row without plan or status (checkout in flight) stays Free and writable", () => {
    expect(resolveEntitlements(makeSub({ plan: null, status: null }), NOW)).toEqual({
      plan: "FREE",
      maxGroups: PLAN_LIMITS.FREE.groups,
      maxMembersPerGroup: PLAN_LIMITS.FREE.membersPerGroup,
      writable: true,
      graceEndsAt: null,
    });
  });
});
