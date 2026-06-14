import type { DateString } from "../../utils/dateFunc.js";
import { z } from "zod";
import { vacationType } from "../../db/schema/vacation-schema.js";
import type { UserSummary } from "../../utils/userPresentation.js";

export type VacationType = {
  id: string;
  userId: string;
  groupId: string;
  requestedDay: DateString;
  startTime: string | null;
  endTime: string | null;
  vacationType: vacationType;
  approvedAt: Date | null;
  approvedBy: string | null;
  deletedAt: Date | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type VacationInsertType = Pick<
  VacationType,
  | "id"
  | "userId"
  | "groupId"
  | "requestedDay"
  | "startTime"
  | "endTime"
  | "vacationType"
> & {
  note?: string | null;
};

export type VacationListItem = VacationType & {
  user: UserSummary;
};

const vacationKindEnum = z.enum(
  Object.values(vacationType) as [vacationType, ...vacationType[]]
);

export const validatePostVacation = z.object({
  groupId: z.uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  vacationType: vacationKindEnum.default(vacationType.Vacation),
  startTime: z.iso.time().nullable().default(null),
  endTime: z.iso.time().nullable().default(null),
  note: z.string().max(1000).nullable().default(null),
});

export type ValidatedPostVacationType = z.infer<typeof validatePostVacation>;

export const validateRejectVacation = z.object({
  reason: z.string().max(1000).optional(),
});

export type ValidatedRejectVacationType = z.infer<
  typeof validateRejectVacation
>;

const ids = z.array(z.uuid()).min(1).max(366);

export const validateBulkApproveVacation = z.object({
  ids,
});

export type ValidatedBulkApproveVacationType = z.infer<
  typeof validateBulkApproveVacation
>;

export const validateBulkRejectVacation = z.object({
  ids,
  reason: z.string().max(1000).optional(),
});

export type ValidatedBulkRejectVacationType = z.infer<
  typeof validateBulkRejectVacation
>;
