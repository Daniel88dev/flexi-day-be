import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildReportWorkbook, type SummaryRow } from "../excelBuilder.js";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";
import type { ReportBooking } from "../types.js";

const summaryRow = (overrides: Partial<SummaryRow> = {}): SummaryRow => ({
  userName: "Ada Lovelace",
  groupName: "Engineering",
  vacationType: CalendarRecordType.Vacation,
  carriedOverDays: 3,
  yearQuota: 20,
  usedToDate: 5,
  plannedRemaining: 2,
  pending: 1,
  remaining: 16,
  ...overrides,
});

const booking = (overrides: Partial<ReportBooking> = {}): ReportBooking => ({
  userId: "u1",
  userName: "Ada Lovelace",
  groupId: "g1",
  groupName: "Engineering",
  vacationType: CalendarRecordType.Vacation,
  from: "2026-03-12",
  to: "2026-03-14",
  days: 3,
  year: 2026,
  month: 3,
  status: "approved",
  note: null,
  ...overrides,
});

const readBack = async (buffer: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
};

describe("buildReportWorkbook", () => {
  it("writes a summary sheet and a detail sheet", async () => {
    const workbook = await readBack(
      await buildReportWorkbook({ year: 2026, summary: [summaryRow()], bookings: [booking()] })
    );

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Summary 2026", "Detail"]);
  });

  it("enables AutoFilter across every column on both sheets", async () => {
    const workbook = await readBack(
      await buildReportWorkbook({ year: 2026, summary: [summaryRow()], bookings: [booking()] })
    );

    for (const sheet of workbook.worksheets) {
      expect(sheet.autoFilter).toBeTruthy();
    }
  });

  it("puts the carry-over and remaining figures on the summary sheet", async () => {
    const workbook = await readBack(
      await buildReportWorkbook({ year: 2026, summary: [summaryRow()], bookings: [] })
    );
    const row = workbook.getWorksheet("Summary 2026")?.getRow(2);

    expect(row?.getCell(1).value).toBe("Ada Lovelace");
    expect(row?.getCell(4).value).toBe(3);
    expect(row?.getCell(9).value).toBe(16);
  });

  it("renders a multi-day booking as a range and a single day as one date", async () => {
    const workbook = await readBack(
      await buildReportWorkbook({
        year: 2026,
        summary: [],
        bookings: [booking(), booking({ from: "2026-05-01", to: "2026-05-01", days: 1 })],
      })
    );
    const sheet = workbook.getWorksheet("Detail");

    expect(sheet?.getRow(2).getCell(7).value).toBe("2026-03-12 – 2026-03-14");
    expect(sheet?.getRow(3).getCell(7).value).toBe("2026-05-01");
  });

  it("writes the month as a name so the Excel filter reads well", async () => {
    const workbook = await readBack(
      await buildReportWorkbook({ year: 2026, summary: [], bookings: [booking()] })
    );

    expect(workbook.getWorksheet("Detail")?.getRow(2).getCell(9).value).toBe("March");
  });

  it("keeps a half-day total as 0.5 rather than rounding it", async () => {
    const workbook = await readBack(
      await buildReportWorkbook({
        year: 2026,
        summary: [],
        bookings: [booking({ days: 0.5, to: "2026-03-12" })],
      })
    );

    expect(workbook.getWorksheet("Detail")?.getRow(2).getCell(4).value).toBe(0.5);
  });

  it("produces a valid workbook with no rows at all", async () => {
    const workbook = await readBack(
      await buildReportWorkbook({ year: 2026, summary: [], bookings: [] })
    );

    expect(workbook.getWorksheet("Detail")?.getRow(1).getCell(1).value).toBe("Name");
  });
});
