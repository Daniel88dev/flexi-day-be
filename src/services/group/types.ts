import { z } from "zod";

export type GroupType = {
  id: string;
  groupName: string;
  defaultVacationDays: number;
  defaultHomeOfficeDays: number;
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
