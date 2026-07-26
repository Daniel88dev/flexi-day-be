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

// Working days are JS `Date.getUTCDay()` numbers (0=Sun … 6=Sat). At least one
// day must be a working day, otherwise every vacation request would be
// rejected. Duplicates are collapsed and the result is sorted for stability.
export const validatePutGroupWorkingDays = z.object({
  workingDays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .transform((days) => Array.from(new Set(days)).sort((a, b) => a - b)),
});

export type ValidatedPutGroupWorkingDaysType = z.infer<typeof validatePutGroupWorkingDays>;
