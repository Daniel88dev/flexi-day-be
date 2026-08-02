import { z } from "zod";

export type GroupType = {
  id: string;
  groupName: string;
  defaultVacationDays: number;
  defaultHomeOfficeDays: number;
  workingDays: number[];
  managerUserId: string;
  mainApprovalUser: string | null;
  tempApprovalUser: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupInsertType = {
  id: string;
  groupName: string;
  managerUserId: string;
  defaultVacationDays?: number;
  defaultHomeOfficeDays?: number;
  mainApprovalUser?: string;
};

export const validatePutGroupQuotas = z.object({
  defaultVacationDays: z.number().int().min(0).max(365),
  defaultHomeOfficeDays: z.number().int().min(0).max(365),
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

// better-auth user ids are opaque non-UUID strings. The main approver is
// required: a group without one can never decide on a request.
export const validatePutGroupApprovers = z.object({
  mainApprovalUser: z.string().min(1),
  tempApprovalUser: z.string().min(1).nullable().default(null),
});

export type ValidatedPutGroupApproversType = z.infer<typeof validatePutGroupApprovers>;
