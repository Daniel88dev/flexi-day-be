import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { getMyBalances } from "../../services/userYearQuotas/balanceReads.js";

const queryParams = z.object({
  year: z.coerce
    .number()
    .int()
    .min(2023)
    .max(2100)
    .prefault(() => new Date().getFullYear()),
});

export const handleGetMyBalances = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { year } = queryParams.parse(req.query);

  const balances = await getMyBalances({ auth, year });

  return res.status(200).json(balances);
};
