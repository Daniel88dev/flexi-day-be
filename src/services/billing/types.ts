import { z } from "zod";
import type {
  billingCycle,
  manualPlanOverride,
  subscriptionPlan,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";

export type Subscription = {
  id: string;
  organizationId: string;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  plan: subscriptionPlan | null;
  status: subscriptionStatus | null;
  billingCycle: billingCycle | null;
  extraGroupSlots: number;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  cancelAt: Date | null;
  manualPlanOverride: manualPlanOverride | null;
  manualMaxGroups: number | null;
  manualMaxMembersPerGroup: number | null;
  manualPlanUntil: Date | null;
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Any subset of the mutable subscription state; unmentioned fields keep their stored value. */
export type SubscriptionPatch = Partial<
  Omit<Subscription, "id" | "organizationId" | "createdAt" | "updatedAt">
>;

export const validatePostCheckout = z.object({
  plan: z.enum(["PRO", "ENTERPRISE"]),
  billingCycle: z.enum(["MONTHLY", "YEARLY"]),
  extraGroupSlots: z.number().int().min(0).max(20).optional().default(0),
});

export type ValidatedPostCheckoutType = z.infer<typeof validatePostCheckout>;

export const validatePatchSlots = z.object({
  extraGroupSlots: z.number().int().min(0).max(20),
});

export type ValidatedPatchSlotsType = z.infer<typeof validatePatchSlots>;

export const validateChangePlan = z.object({
  plan: z.enum(["PRO", "ENTERPRISE"]),
  billingCycle: z.enum(["MONTHLY", "YEARLY"]),
});

export type ValidatedChangePlanType = z.infer<typeof validateChangePlan>;
