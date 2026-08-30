import { z } from "zod";

export type UserYearQuotasType = {
  id: string;
  userId: string;
  groupId: string;
  relatedYear: string;
  vacationDays: number;
  homeOfficeDays: number;
  sickDays: number;
  carriedOverDays: number;
  createdAt: Date;
  updatedAt: Date;
};

export type UserYearQuotasInsertType = Pick<
  UserYearQuotasType,
  "id" | "userId" | "groupId" | "relatedYear" | "homeOfficeDays"
> & {
  vacationDays?: number;
};

export type UserYearQuotasUpdateType = {
  userId: string;
  groupId: string;
  relatedYear: string;
  vacationChange: number;
  homeOfficeChange: number;
};

export type UserYearQuotasUpsertType = {
  id: string;
  userId: string;
  groupId: string;
  relatedYear: string;
  vacationDays: number;
  homeOfficeDays: number;
  sickDays: number;
  carriedOverDays: number;
};

/**
 * Body of the admin "set this member's allowance for a year" endpoint. The
 * year range mirrors the `user_year_quotas_related_year_range_chk` constraint.
 */
export const validatePutUserQuota = z.object({
  // better-auth user ids are opaque non-UUID strings, so validate as a
  // non-empty string rather than z.uuid().
  userId: z.string().min(1),
  year: z.coerce.number().int().min(2025).max(2100),
  vacationDays: z.number().int().min(0).max(365),
  homeOfficeDays: z.number().int().min(0).max(365),
  // Optional, and omission preserves the stored value: a client predating the
  // Sick day benefit must not wipe a member's allowance on every save.
  sickDays: z.number().int().min(0).max(365).optional(),
  // Optional for the same reason: the group Quotas tab never sends it, and an
  // allowance edit there must not reset a member's carry-over to zero.
  carriedOverDays: z.number().int().min(0).max(365).optional(),
});

export type ValidatedPutUserQuotaType = z.infer<typeof validatePutUserQuota>;
