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
   *       Drives the report's filter controls. The scope covers every live
   *       group the caller belongs to plus every live group they administer
   *       without belonging to it: each group of an organization they own or
   *       hold a delegated admin grant in, and each group they manage.
   *
   *       Each group comes back with an `access` level: `all` when the caller
   *       has view access, admin access, manages the group or administers its
   *       organization, `self` when they are a plain member and may only see
   *       their own rows. `canEditQuotas` is true wherever
   *       `PUT /api/quotas/{groupId}` would accept them: admin access, the
   *       manager, or an org admin, member or not. Groups are ordered by name.
   *       Never 403s — a caller with no view access anywhere still receives
   *       their own memberships scoped to themselves.
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
   *                   description: One row per (member, group) the caller may select
   *                   items:
   *                     type: object
   *                     properties:
   *                       groupId:
   *                         type: string
   *                       id:
   *                         type: string
   *                       name:
   *                         type: string
   *                       initials:
   *                         type: string
   *                       avatarColor:
   *                         type: string
   *                 years:
   *                   type: array
   *                   items:
   *                     type: integer
   *       '401':
   *         description: Unauthorized
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
   *       type) for the table — Sick day rows only for groups whose
   *       organization has the Sick day benefit enabled. A member with no
   *       quota row for the year reads the group defaults as `yearQuota`, with
   *       `carriedOverDays` 0, the same allowance the booking guard enforces.
   *       Day counts are weighted: a `halfDay` booking counts 0.5. The scope is the one
   *       `GET /api/reports/scope` returns, so groups the caller administers
   *       without belonging to them are included in full. Filters outside the
   *       caller's scope are silently dropped rather than rejected.
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
   *       '401':
   *         description: Unauthorized
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
   *       changes recorded against the member for the year. Sick day summary
   *       rows appear only for groups whose organization has the Sick day
   *       benefit enabled. `quotas` lists only the stored quota rows; `summary`
   *       reads the group defaults for a group with no row, as the overview
   *       does. Requires `access: all` on a group the member
   *       belongs to, which includes a group the caller administers without
   *       being a member; callers may always request their own detail. Each
   *       entry of `groups` carries `canEditQuotas` as in
   *       `GET /api/reports/scope`.
   *
   *       Each entry of `changes` carries `actor` and `actorDeleted`. An
   *       `actor` of null with `actorDeleted: false` means the quota rollover
   *       made the change; with `actorDeleted: true`, the person who made it
   *       has since deleted their account.
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
   *       '401':
   *         description: Unauthorized
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
   *       day for groups whose organization has the Sick day benefit enabled,
   *       with the same figures as `GET /api/reports/overview`, group defaults
   *       included for a member with no quota row. Bank holidays never appear in
   *       the workbook: a company-wide closure is not leave anyone took, so
   *       `BANK_HOLIDAY` is rejected as a filter value and its rows are
   *       excluded even without a filter. Each call writes a
   *       `report_exports` audit row naming the caller, year and filters.
   *       Covers the scope `GET /api/reports/scope` returns, including groups
   *       the caller administers without belonging to them.
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
   *                 minimum: 2025
   *                 maximum: 2100
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
   *       '401':
   *         description: Unauthorized
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
