import { z } from "zod";

export const monthFields = {
  year: z
    .number()
    .int()
    .min(2023)
    .max(2050)
    .optional()
    .describe("The calendar year. Defaults to the current year."),
  month: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe("The month, 1 to 12. Defaults to the current month."),
};

/** The month an input names, today's (UTC) where it names none. */
export const monthOf = (input: { year?: number | undefined; month?: number | undefined }) => {
  const now = new Date();
  return {
    year: input.year ?? now.getUTCFullYear(),
    month: input.month ?? now.getUTCMonth() + 1,
  };
};

/** The month's first and last day, `YYYY-MM-DD`, both inclusive. */
export const monthDays = (year: number, month: number) => ({
  first: new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10),
  last: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
});
