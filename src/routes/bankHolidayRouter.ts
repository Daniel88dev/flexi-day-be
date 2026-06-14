import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetBankHolidays } from "../controllers/bankHoliday/handleGetBankHolidays.js";

export const bankHolidayRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/bank-holidays:
   *   get:
   *     tags:
   *       - BankHolidays
   *     summary: List bank holidays for a country (and optional region) and year
   *     parameters:
   *       - name: year
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *       - name: country
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *       - name: region
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Array of bank holidays
   */
  app.get("/", tryCatch(handleGetBankHolidays));

  return app;
};
