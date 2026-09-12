import type { Request, Response } from "express";
import { validateBankHolidayQuery } from "../../services/bankHoliday/types.js";
import { ensureBankHolidays } from "../../services/bankHoliday/bankHolidayServices.js";

export const handleGetBankHolidays = async (req: Request, res: Response) => {
  const query = validateBankHolidayQuery.parse(req.query);

  const result = await ensureBankHolidays(query.year, query.country, query.region);

  return res.status(200).json(
    result.map((row) => ({
      date: row.date,
      name: row.name,
      country: row.country,
      region: row.region ?? undefined,
    }))
  );
};
