import type { Request, Response } from "express";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import {
  manualPlanOverride,
  subscriptionPlan,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";
import { resolveEntitlements } from "../../services/billing/entitlements.js";
import { assertSeedEmail } from "../../services/dev/devSeedServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { getUserByEmail } from "../../services/user/userServices.js";

export const validatePostDevSetPlan = z.object({
  email: z.email(),
  /**
   * What to force:
   * - FREE / PRO / ENTERPRISE / CUSTOM — a manual plan override;
   * - GRACE — a lapsed Pro subscription still inside its 14-day grace window;
   * - EXPIRED — a lapsed Pro subscription past grace (read-only over limits);
   * - CLEAR — remove the override and any forced state.
   */
  state: z.enum(["FREE", "PRO", "ENTERPRISE", "CUSTOM", "GRACE", "EXPIRED", "CLEAR"]),
  manualMaxGroups: z.number().int().min(0).optional(),
  manualMaxMembersPerGroup: z.number().int().min(0).optional(),
});

type ValidatedPostDevSetPlan = z.infer<typeof validatePostDevSetPlan>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Forces a billing state for a seeded user's organization without touching
 * Paddle, so limits, grace and read-only behavior can be exercised locally.
 */
export const handlePostDevSetPlan = async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPostDevSetPlan = req.body;

  // Same scope as every other dev mutation: only seeded accounts, so that
  // `POST /api/dev/reset` can always undo whatever this created.
  assertSeedEmail(data.email);

  const user = await getUserByEmail(data.email.toLowerCase());
  if (!user) {
    throw new AppError({ message: "User not found", code: 404, context: { email: data.email } });
  }

  const organization = await ensureOrganizationForUser(user.id);

  const clearPatch = {
    manualPlanOverride: null,
    manualMaxGroups: null,
    manualMaxMembersPerGroup: null,
    manualPlanUntil: null,
  };

  const patch = (() => {
    switch (data.state) {
      case "CLEAR":
        return { ...clearPatch, plan: null, status: null, graceEndsAt: null };
      case "GRACE":
        return {
          ...clearPatch,
          plan: subscriptionPlan.Pro,
          status: subscriptionStatus.PastDue,
          graceEndsAt: new Date(Date.now() + 14 * DAY_MS),
        };
      case "EXPIRED":
        return {
          ...clearPatch,
          plan: subscriptionPlan.Pro,
          status: subscriptionStatus.Canceled,
          graceEndsAt: new Date(Date.now() - DAY_MS),
        };
      default:
        return {
          ...clearPatch,
          manualPlanOverride: data.state as manualPlanOverride,
          manualMaxGroups: data.manualMaxGroups ?? null,
          manualMaxMembersPerGroup: data.manualMaxMembersPerGroup ?? null,
        };
    }
  })();

  const subscription = await upsertSubscription(organization.id, patch);

  return res.status(200).json({
    organizationId: organization.id,
    subscription,
    entitlements: resolveEntitlements(subscription ?? null, new Date()),
  });
};
