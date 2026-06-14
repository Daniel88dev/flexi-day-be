import type { Request, Response } from "express";
import { createDBServices } from "../../services/DBServices.js";
import { validateBankHolidayQuery } from "../../services/bankHoliday/types.js";

const services = createDBServices();

export const handleGetBankHolidays = async (req: Request, res: Response) => {
  const query = validateBankHolidayQuery.parse(req.query);

  const result = await services.bankHoliday.listBankHolidays(
    query.year,
    query.country,
    query.region
  );

  return res.status(200).json(
    result.map((row) => ({
      date: row.date,
      name: row.name,
      country: row.country,
      region: row.region ?? undefined,
    }))
  );
};
