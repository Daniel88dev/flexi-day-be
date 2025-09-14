import type { DateString } from "../../utils/dateFunc.js";
import { z } from "zod";

export type VacationType = {
  id: string;
  userId: string;
  groupId: string;
  requestedDay: DateString;
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
  "id" | "userId" | "groupId" | "requestedDay"
>;

export const validatePostVacation = z.object({
  groupId: z.uuid(),
  requestedDay: z.coerce.date(),
});

export type ValidatedPostVacationType = z.infer<typeof validatePostVacation>;
