import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetBankHolidays } from "../controllers/bankHoliday/handleGetBankHolidays.js";
import { handleGetBankHolidayCountries } from "../controllers/bankHoliday/handleGetBankHolidayCountries.js";

export const bankHolidayRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/bank-holidays/countries:
   *   get:
   *     tags:
   *       - BankHolidays
   *     summary: List countries with a supported public holiday dataset
   *     description: |
   *       Returns every country the holiday dataset can compute public
   *       holidays for. Codes are ISO 3166-1 alpha-2 and are the only values
   *       accepted by `PUT /api/group/{groupId}/holiday-country`.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Array of supported countries
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   code:
   *                     type: string
   *                     example: CZ
   *                   name:
   *                     type: string
   *                     example: Czech Republic
   *       '401':
   *         description: Unauthorized - missing or invalid authentication
   */
  app.get("/countries", tryCatch(handleGetBankHolidayCountries));

  /**
   * @openapi
   * /api/bank-holidays:
   *   get:
   *     tags:
   *       - BankHolidays
   *     summary: List bank holidays for a country (and optional region) and year
   *     description: |
   *       Serves from the `bank_holidays` table. On the first request for a
   *       supported country and year the public holidays are computed from the
   *       bundled dataset and cached in the table. Unsupported countries
   *       return an empty array.
   *     security:
   *       - bearerAuth: []
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
   *       '401':
   *         description: Unauthorized - missing or invalid authentication
   */
  app.get("/", tryCatch(handleGetBankHolidays));

  return app;
};
