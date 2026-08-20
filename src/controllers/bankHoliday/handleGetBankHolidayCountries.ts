import type { Request, Response } from "express";
import { getSupportedCountries } from "../../services/bankHoliday/holidayDataset.js";

export const handleGetBankHolidayCountries = (_req: Request, res: Response) => {
  return res.status(200).json(getSupportedCountries());
};
