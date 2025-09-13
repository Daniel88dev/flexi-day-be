import type { DateString } from "../../utils/dateFunc.js";
import { z } from "zod";

export type VacationInsertType = {
  id: string;
  userId: string;
  groupId: string;
  requestedDay: DateString;
};

export type VacationType = {
  id: string;
  userId: string;
  groupId: string;
  requestedDay: DateString;
  createdAt: Date;
  updatedAt: Date;
};

export const validatePostVacation = z.object({
  groupId: z.uuid(),
  requestedDay: z.date(),
});

export type ValidatedPostVacationType = z.infer<typeof validatePostVacation>;
