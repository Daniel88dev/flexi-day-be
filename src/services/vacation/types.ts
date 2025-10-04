import type { DateString } from "../../utils/dateFunc.js";
import { z } from "zod";
import type { vacationType } from "../../db/schema/vacation-schema.js";

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
>;

export const validatePostVacation = z.object({
  groupId: z.uuid(),
  requestedDay: z.coerce.date(),
  startTime: z.iso.time().nullable().default(null),
  endTime: z.iso.time().nullable().default(null),
});

export type ValidatedPostVacationType = z.infer<typeof validatePostVacation>;
