import { z } from "zod";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import type { UserSummary } from "../../utils/userPresentation.js";

/**
 * What one membership lets the caller see in the report. `all` covers every
 * member of the group (view access, admin access, or being its manager);
 * `self` is the fallback every member gets for their own data.
 */
export type ReportScopeAccess = "all" | "self";

export type ReportScopeEntry = {
  groupId: string;
  groupName: string;
  access: ReportScopeAccess;
  canEditQuotas: boolean;
};

export type ReportScopeMember = UserSummary & {
  groupId: string;
};

export type ReportScope = {
  groups: ReportScopeEntry[];
  members: ReportScopeMember[];
  years: number[];
};

export type MonthlyUsageRow = {
  userId: string;
  groupId: string;
  month: number;
  vacationType: CalendarRecordType;
  used: number;
  pending: number;
};

export type ReportQuotaRow = {
  userId: string;
  groupId: string;
  vacationDays: number;
  homeOfficeDays: number;
  sickDays: number;
  carriedOverDays: number;
};

export type ReportUsageSplit = {
  usedToDate: number;
  plannedRemaining: number;
  pending: number;
};

export type MemberChangeEntry = {
  id: string;
  groupId: string;
  changeType: string;
  changeDetail: string;
  actor: UserSummary | null;
  createdAt: string;
};

/** One collapsed booking as it appears on the export's detail sheet. */
export type ReportBooking = {
  userId: string;
  userName: string;
  groupId: string;
  groupName: string;
  vacationType: CalendarRecordType;
  from: string;
  to: string;
  days: number;
  year: number;
  month: number;
  status: "approved" | "pending" | "rejected";
  note: string | null;
};

const recordTypeEnum = z.enum(CalendarRecordType);

/**
 * `BANK_HOLIDAY` is deliberately absent: the export answers what leave people
 * took, and a company-wide closure is not part of that answer. The overview
 * (`validateReportQuery`) still accepts it.
 */
const exportableRecordTypeEnum = recordTypeEnum.exclude(["BankHoliday"]);

export const EXPORTABLE_CALENDAR_RECORD_TYPES = exportableRecordTypeEnum.options;

/**
 * Comma-separated repeatable query filters (`?groupIds=a,b&groupIds=c`), which
 * is what `URLSearchParams` produces when the UI appends one entry per chip.
 */
const csvList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const parts = (Array.isArray(value) ? value : [value])
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim())
      .filter(Boolean);
    return parts.length > 0 ? Array.from(new Set(parts)) : undefined;
  });

const yearField = z.coerce
  .number()
  .int()
  .min(2025)
  .max(2100)
  .prefault(() => new Date().getFullYear());

export const validateReportQuery = z.object({
  year: yearField,
  groupIds: csvList,
  userIds: csvList,
  types: csvList.pipe(z.array(recordTypeEnum).optional()),
});

export type ValidatedReportQuery = z.infer<typeof validateReportQuery>;

export const validateMemberReportQuery = z.object({
  year: yearField,
});

export type ValidatedMemberReportQuery = z.infer<typeof validateMemberReportQuery>;

export const validateExportRequest = z.object({
  year: z.number().int().min(2025).max(2100),
  groupIds: z.array(z.string().min(1)).max(200).optional(),
  userIds: z.array(z.string().min(1)).max(2000).optional(),
  types: z.array(exportableRecordTypeEnum).max(20).optional(),
});

export type ValidatedExportRequest = z.infer<typeof validateExportRequest>;

export type ReportExportInsertType = {
  id: string;
  userId: string;
  relatedYear: string;
  filters: ValidatedExportRequest;
  rowCount: number;
};
