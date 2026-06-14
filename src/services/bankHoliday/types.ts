import { z } from "zod";

export type BankHolidayType = {
  id: string;
  date: string;
  name: string;
  country: string;
  region: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BankHolidayInsertType = Pick<
  BankHolidayType,
  "id" | "date" | "name" | "country"
> & {
  region?: string | null;
};

export const validateBankHolidayQuery = z.object({
  year: z.coerce
    .number()
    .int()
    .min(1970)
    .max(2100)
    .prefault(() => new Date().getFullYear()),
  country: z
    .string()
    .min(2)
    .max(8)
    .transform((value) => value.toUpperCase()),
  region: z.string().min(1).max(64).optional(),
});

export type ValidatedBankHolidayQuery = z.infer<
  typeof validateBankHolidayQuery
>;
