import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { handleGetReportScope } from "../controllers/report/handleGetReportScope.js";
import { handleGetReportOverview } from "../controllers/report/handleGetReportOverview.js";
import { handleGetMemberReport } from "../controllers/report/handleGetMemberReport.js";
import { handlePostReportExport } from "../controllers/report/handlePostReportExport.js";
import { validateExportRequest } from "../services/report/types.js";

export const reportRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/reports/scope:
   *   get:
   *     tags:
   *       - Reports
   *     summary: Groups, members and years the caller may report on
   *     description: |
   *       Drives the report's filter controls. Each group comes back with an
   *       `access` level: `all` when the caller has view access, admin access
   *       or manages the group, `self` when they are a plain member and may
   *       only see their own rows. Never 403s — a caller with no view access
   *       anywhere still receives their own memberships scoped to themselves.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Scope descriptor
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 groups:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       groupId:
   *                         type: string
   *                       groupName:
   *                         type: string
   *                       access:
   *                         type: string
   *                         enum: [all, self]
   *                       canEditQuotas:
   *                         type: boolean
   *                 members:
   *                   type: array
   *                   items:
   *                     type: object
   *                 years:
   *                   type: array
   *                   items:
   *                     type: integer
   */
  app.get("/scope", tryCatch(handleGetReportScope));

  /**
   * @openapi
   * /api/reports/overview:
   *   get:
   *     tags:
   *       - Reports
   *     summary: Monthly usage series and allowance summary
   *     description: |
   *       Returns one `monthly` row per (member, group, month, record type) for
   *       the charts, and one `summary` row per (member, group, quota-bearing
   *       type) for the table. Day counts are weighted: a `halfDay` booking
   *       counts 0.5. Filters outside the caller's scope are silently dropped
   *       rather than rejected.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: year
   *         in: query
   *         schema:
   *           type: integer
   *           default: current year
   *       - name: groupIds
   *         in: query
   *         description: Repeatable or comma-separated group ids
   *         schema:
   *           type: string
   *       - name: userIds
   *         in: query
   *         description: Repeatable or comma-separated user ids
   *         schema:
   *           type: string
   *       - name: types
   *         in: query
   *         description: |
   *           Repeatable or comma-separated record types. Accepted values: VACATION,
   *           HOME_OFFICE, SICK, BANK_HOLIDAY, NON_PAID_LEAVE, PAID_TIME_OFF, SICK_DAY,
   *           STUDY_LEAVE, OTHER.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Report payload
   */
  app.get("/overview", tryCatch(handleGetReportOverview));

  /**
   * @openapi
   * /api/reports/members/{userId}:
   *   get:
   *     tags:
   *       - Reports
   *     summary: One member's year in detail
   *     description: |
   *       Allowances, monthly usage, every booking and the admin-made quota
   *       changes recorded against the member for the year. Requires full view
   *       access on a group the member belongs to; callers may always request
   *       their own detail.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: userId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *       - name: year
   *         in: query
   *         schema:
   *           type: integer
   *     responses:
   *       '200':
   *         description: Member detail
   *       '403':
   *         description: No permission to view this member
   *       '404':
   *         description: Member not found
   */
  app.get("/members/:userId", tryCatch(handleGetMemberReport));

  /**
   * @openapi
   * /api/reports/export:
   *   post:
   *     tags:
   *       - Reports
   *     summary: Generate the report as an Excel workbook
   *     description: |
   *       Streams a two-sheet `.xlsx`: allowances as they stand today on the
   *       first sheet, every individual booking on the second, both with Excel
   *       AutoFilter enabled across all columns. The summary sheet carries one
   *       line per member and metered type — Vacation, Home office, and Sick
   *       day for groups whose organization has the Sick day benefit enabled. Bank holidays never appear in
   *       the workbook: a company-wide closure is not leave anyone took, so
   *       `BANK_HOLIDAY` is rejected as a filter value and its rows are
   *       excluded even without a filter. Each call writes a
   *       `report_exports` audit row naming the caller, year and filters.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - year
   *             properties:
   *               year:
   *                 type: integer
   *               groupIds:
   *                 type: array
   *                 items:
   *                   type: string
   *               userIds:
   *                 type: array
   *                 items:
   *                   type: string
   *               types:
   *                 type: array
   *                 items:
   *                   type: string
   *                   enum:
   *                     - VACATION
   *                     - HOME_OFFICE
   *                     - SICK
   *                     - NON_PAID_LEAVE
   *                     - PAID_TIME_OFF
   *                     - SICK_DAY
   *                     - STUDY_LEAVE
   *                     - OTHER
   *     responses:
   *       '200':
   *         description: The workbook
   *         content:
   *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
   *             schema:
   *               type: string
   *               format: binary
   *       '413':
   *         description: Too many rows for one export — narrow the filters
   *       '422':
   *         description: Invalid body — year out of range or a non-exportable type
   */
  app.post(
    "/export",
    bodyValidationMiddleware(validateExportRequest),
    tryCatch(handlePostReportExport)
  );

  return app;
};
