import ExcelJS from "exceljs";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import type { ReportBooking } from "./types.js";

export type SummaryRow = {
  userName: string;
  groupName: string;
  vacationType: CalendarRecordType;
  carriedOverDays: number;
  yearQuota: number;
  usedToDate: number;
  plannedRemaining: number;
  pending: number;
  remaining: number;
};

const CALENDAR_RECORD_TYPE_LABELS: Record<CalendarRecordType, string> = {
  [CalendarRecordType.Vacation]: "Vacation",
  [CalendarRecordType.HomeOffice]: "Home Office",
  [CalendarRecordType.Sick]: "Sick",
  [CalendarRecordType.BankHoliday]: "Bank Holiday",
  [CalendarRecordType.NonPaidLeave]: "Non-Paid Leave",
  [CalendarRecordType.PaidTimeOff]: "Paid Time Off",
  [CalendarRecordType.SickDay]: "Sick Day",
  [CalendarRecordType.StudyLeave]: "Study Leave",
  [CalendarRecordType.Other]: "Other",
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2937" },
};

/**
 * Writes the header row, freezes it, turns on Excel's AutoFilter across every
 * column and sizes the columns. Both sheets are filterable end to end, which
 * is the whole point of exporting rather than screenshotting the report.
 */
const styleSheet = (sheet: ExcelJS.Worksheet, widths: number[]): void => {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: "middle" };
  header.height = 20;

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(sheet.rowCount, 1), column: widths.length },
  };

  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
};

const buildSummarySheet = (workbook: ExcelJS.Workbook, year: number, rows: SummaryRow[]): void => {
  const sheet = workbook.addWorksheet(`Summary ${year.toString()}`);

  sheet.columns = [
    { header: "Name", key: "userName" },
    { header: "Group", key: "groupName" },
    { header: "Type", key: "type" },
    { header: "Carried over from previous year", key: "carriedOverDays" },
    { header: "Quota for whole year", key: "yearQuota" },
    { header: "Used to date", key: "usedToDate" },
    { header: "Planned until end of year", key: "plannedRemaining" },
    { header: "Pending approval", key: "pending" },
    { header: "Remaining", key: "remaining" },
  ];

  for (const row of rows) {
    sheet.addRow({ ...row, type: CALENDAR_RECORD_TYPE_LABELS[row.vacationType] });
  }

  styleSheet(sheet, [26, 22, 16, 30, 20, 14, 24, 18, 14]);
};

const buildDetailSheet = (workbook: ExcelJS.Workbook, bookings: ReportBooking[]): void => {
  const sheet = workbook.addWorksheet("Detail");

  sheet.columns = [
    { header: "Name", key: "userName" },
    { header: "Group", key: "groupName" },
    { header: "Type", key: "type" },
    { header: "Days", key: "days" },
    { header: "From", key: "from" },
    { header: "To", key: "to" },
    { header: "Day range", key: "range" },
    { header: "Year", key: "year" },
    { header: "Month", key: "month" },
    { header: "Status", key: "status" },
    { header: "Note", key: "note" },
  ];

  for (const booking of bookings) {
    sheet.addRow({
      userName: booking.userName,
      groupName: booking.groupName,
      type: CALENDAR_RECORD_TYPE_LABELS[booking.vacationType],
      days: booking.days,
      from: booking.from,
      to: booking.to,
      range: booking.from === booking.to ? booking.from : `${booking.from} – ${booking.to}`,
      year: booking.year,
      month: MONTH_NAMES[booking.month - 1] ?? booking.month.toString(),
      status: booking.status.charAt(0).toUpperCase() + booking.status.slice(1),
      note: booking.note ?? "",
    });
  }

  styleSheet(sheet, [26, 22, 16, 8, 13, 13, 26, 8, 13, 12, 40]);
};

/**
 * Two-sheet workbook: allowances as they stand today on the first, every
 * individual booking on the second.
 */
export const buildReportWorkbook = async (input: {
  year: number;
  summary: SummaryRow[];
  bookings: ReportBooking[];
}): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Flexi Day";
  workbook.created = new Date();

  buildSummarySheet(workbook, input.year, input.summary);
  buildDetailSheet(workbook, input.bookings);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
};
