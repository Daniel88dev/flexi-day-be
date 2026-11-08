import { z } from "zod";
import { getMyBalances } from "../../services/userYearQuotas/balanceReads.js";
import { defineTool } from "../types.js";

export const getMyBalancesTool = defineTool({
  name: "get_my_balances",
  description:
    "Your allowance and usage for one year in this organization: for each record type (VACATION, HOME_OFFICE, SICK_DAY and others), the days allocated, used (approved), pending approval, and remaining (allocated minus used, as the app shows it; pending days are not subtracted yet). Summed across your groups in the organization.",
  input: z.object({
    year: z
      .number()
      .int()
      .min(2023)
      .max(2050)
      .optional()
      .describe("The calendar year. Defaults to the current year."),
  }),
  annotations: { title: "Your balances", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  userText: [],
  handler: async (ctx, input) => {
    const { year, buckets } = await getMyBalances({
      auth: ctx.auth,
      year: input.year ?? new Date().getUTCFullYear(),
      organizationId: ctx.organizationId,
    });
    return {
      year: Number(year),
      buckets: buckets.map((bucket) => ({
        ...bucket,
        remaining: bucket.allocated - bucket.used,
      })),
    };
  },
});
