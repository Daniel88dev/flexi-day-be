import type { Request, Response } from "express";
import { validateBankHolidayQuery } from "../../services/bankHoliday/types.js";
import {
  computePublicHolidays,
  isSupportedCountry,
} from "../../services/bankHoliday/holidayDataset.js";
import {
  insertBankHolidays,
  listBankHolidays,
} from "../../services/bankHoliday/bankHolidayServices.js";

export const handleGetBankHolidays = async (req: Request, res: Response) => {
  const query = validateBankHolidayQuery.parse(req.query);

  let result = await listBankHolidays(query.year, query.country, query.region);

  // Lazy fill: the table starts empty and is populated per (country, year) on
  // first request. Unsupported countries simply stay empty. Region-filtered
  // misses must not refill — the dataset rows carry no region, so the refill
  // would duplicate an already-cached country instead of satisfying the query.
  if (result.length === 0 && !query.region && isSupportedCountry(query.country)) {
    const computed = computePublicHolidays(query.country, query.year);
    if (computed.length > 0) {
      await insertBankHolidays(computed);
      result = await listBankHolidays(query.year, query.country, query.region);
    }
  }

  return res.status(200).json(
    result.map((row) => ({
      date: row.date,
      name: row.name,
      country: row.country,
      region: row.region ?? undefined,
    }))
  );
};
