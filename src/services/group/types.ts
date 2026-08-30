import { z } from "zod";
import { isSupportedCountry } from "../bankHoliday/holidayDataset.js";

export type GroupType = {
  id: string;
  organizationId: string;
  groupName: string;
  defaultVacationDays: number;
  defaultHomeOfficeDays: number;
  defaultSickDays: number;
  workingDays: number[];
  holidayCountry: string | null;
  managerUserId: string;
  mainApprovalUser: string | null;
  tempApprovalUser: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupInsertType = {
  id: string;
  organizationId: string;
  groupName: string;
  managerUserId: string;
  defaultVacationDays?: number;
  defaultHomeOfficeDays?: number;
  mainApprovalUser?: string;
};

export const validatePutGroupQuotas = z.object({
  defaultVacationDays: z.number().int().min(0).max(365),
  defaultHomeOfficeDays: z.number().int().min(0).max(365),
  // Optional, and omission preserves the stored value: a client predating the
  // Sick day benefit must not wipe a configured default on every save.
  defaultSickDays: z.number().int().min(0).max(365).optional(),
});

export type ValidatedPutGroupQuotasType = z.infer<typeof validatePutGroupQuotas>;

export const validatePutGroupWorkingDays = z.object({
  workingDays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .transform((days) => Array.from(new Set(days)).sort((a, b) => a - b)),
});

export type ValidatedPutGroupWorkingDaysType = z.infer<typeof validatePutGroupWorkingDays>;

// Validated against the holiday dataset, not just the alpha-2 shape — a code
// we cannot compute holidays for would silently show nothing on the dashboard.
export const validatePutGroupHolidayCountry = z.object({
  holidayCountry: z
    .string()
    .length(2)
    .transform((value) => value.toUpperCase())
    .refine(isSupportedCountry, { message: "Unsupported country code" })
    .nullable(),
});

export type ValidatedPutGroupHolidayCountryType = z.infer<typeof validatePutGroupHolidayCountry>;

// better-auth user ids are opaque non-UUID strings. The main approver is
// required: a group without one can never decide on a request.
export const validatePutGroupApprovers = z.object({
  mainApprovalUser: z.string().min(1),
  tempApprovalUser: z.string().min(1).nullable().default(null),
});

export type ValidatedPutGroupApproversType = z.infer<typeof validatePutGroupApprovers>;
