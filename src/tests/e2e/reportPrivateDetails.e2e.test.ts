import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import type { MonthlyUsageRow, ReportBooking } from "../../services/report/types.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  dayIn,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

const YEAR = new Date().getFullYear() + 1;
const MONTH = 3;
const day = (d: number) => dayIn(YEAR, MONTH, d);

/**
 * "Team" belongs to the owner's organization and is managed by Mia, who holds
 * no membership row. Ann approves it. Bob and Carol are View members. Carol
 * also administers "Side", where Dan is a plain member, so her export spans a
 * group she is privileged in and one she is a teammate in.
 */
const seed = async () => {
  const owner = await makeUser("Olivia Owner");
  const mia = await makeUser("Mia Manager");
  const ann = await makeUser("Ann Approver");
  const bob = await makeUser("Bob Member");
  const carol = await makeUser("Carol Member");
  const dan = await makeUser("Dan Side");

  const team = await makeGroup("Team", mia.id, { organizationOwnerId: owner.id });
  await addMember(team, ann.id, { viewAccess: true, approverAccess: true });
  await addMember(team, bob.id, { viewAccess: true });
  await addMember(team, carol.id, { viewAccess: true });

  const side = await makeGroup("Side", carol.id);
  await addMember(side, carol.id, { viewAccess: true, adminAccess: true });
  await addMember(side, dan.id);

  await addLeave(team, bob.id, day(2), { type: CalendarRecordType.Sick, note: "bob-sick-note" });
  await addLeave(team, bob.id, day(4), {
    type: CalendarRecordType.SickDay,
    note: "bob-sickday-note",
  });
  await addLeave(team, bob.id, day(9), { approved: false, note: "bob-pending-note" });
  await addLeave(team, bob.id, day(11), {
    approved: false,
    rejected: true,
    rejectedBy: ann.id,
    rejectionReason: "bob-rejection-reason",
    note: "bob-rejected-note",
  });

  await addLeave(team, carol.id, day(16), {
    type: CalendarRecordType.Sick,
    note: "carol-own-sick-note",
  });
  await addLeave(team, carol.id, day(18), {
    approved: false,
    rejected: true,
    rejectedBy: ann.id,
    note: "carol-own-rejected-note",
  });

  await addLeave(side, dan.id, day(20), { type: CalendarRecordType.Sick, note: "dan-sick-note" });
  await addLeave(side, dan.id, day(22), {
    approved: false,
    rejected: true,
    rejectedBy: carol.id,
    note: "dan-rejected-note",
  });

  return { owner, mia, ann, bob, carol, dan, team, side };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

type DetailRow = {
  name: string;
  group: string;
  type: string;
  status: string;
  note: string;
};

const BOB_PRIVATE_STRINGS = [
  "bob-sick-note",
  "bob-sickday-note",
  "bob-pending-note",
  "bob-rejected-note",
  "bob-rejection-reason",
];

describe("Reports and the export keep teammates' Sick, notes and rejections private", () => {
  let server: LoopbackServer;
  let s: Seeded;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
    s = await seed();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  const overview = async (userId: string, query: Record<string, unknown> = {}) => {
    const res = await request(server.url)
      .get("/api/reports/overview")
      .query({ year: YEAR, ...query })
      .set("Cookie", await authCookieFor(userId));
    expect(res.status).toBe(200);
    return res.body as { monthly: MonthlyUsageRow[] };
  };

  const memberReport = async (userId: string, targetUserId: string) => {
    const res = await request(server.url)
      .get(`/api/reports/members/${targetUserId}`)
      .query({ year: YEAR })
      .set("Cookie", await authCookieFor(userId));
    expect(res.status).toBe(200);
    return res.body as { monthly: MonthlyUsageRow[]; bookings: ReportBooking[] };
  };

  const exportWorkbook = async (userId: string, body: Record<string, unknown> = {}) => {
    const res = await request(server.url)
      .post("/api/reports/export")
      .set("Cookie", await authCookieFor(userId))
      .send({ year: YEAR, ...body })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as ArrayBuffer);

    const detail: DetailRow[] = [];
    workbook.getWorksheet("Detail")?.eachRow((row, index) => {
      if (index === 1) return;
      detail.push({
        name: String(row.getCell(1).value ?? ""),
        group: String(row.getCell(2).value ?? ""),
        type: String(row.getCell(3).value ?? ""),
        status: String(row.getCell(10).value ?? ""),
        note: String(row.getCell(11).value ?? ""),
      });
    });

    const everyCell: string[] = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell((cell) => everyCell.push(String(cell.value ?? "")));
      });
    });

    return { detail, text: everyCell.join("\n") };
  };

  const usageOf = (rows: MonthlyUsageRow[], userId: string, type: CalendarRecordType) =>
    rows.filter((row) => row.userId === userId && row.vacationType === type);

  describe("a View member (teammate) reading another member", () => {
    it("gets no Sick usage for a teammate in the overview, filtered to Sick or not", async () => {
      const all = await overview(s.carol.id);
      expect.soft(usageOf(all.monthly, s.bob.id, CalendarRecordType.Sick)).toEqual([]);

      const sickOnly = await overview(s.carol.id, { types: CalendarRecordType.Sick });
      expect.soft(sickOnly.monthly.filter((row) => row.userId === s.bob.id)).toEqual([]);
    });

    it("gets no Sick, note or rejected booking in a teammate's member report", async () => {
      const report = await memberReport(s.carol.id, s.bob.id);

      expect.soft(usageOf(report.monthly, s.bob.id, CalendarRecordType.Sick)).toEqual([]);
      expect
        .soft(report.bookings.map((b) => b.vacationType))
        .not.toContain(CalendarRecordType.Sick);
      expect.soft(report.bookings.map((b) => b.status)).not.toContain("rejected");
      for (const booking of report.bookings) expect.soft(booking.note ?? null).toBeNull();

      const wire = JSON.stringify(report);
      for (const secret of BOB_PRIVATE_STRINGS) expect.soft(wire).not.toContain(secret);
    });

    it("exports no Sick, note or rejected row of a teammate", async () => {
      const { detail, text } = await exportWorkbook(s.carol.id, { groupIds: [s.team] });
      const bobRows = detail.filter((row) => row.name === s.bob.name);

      expect.soft(bobRows.length).toBeGreaterThan(0);
      expect.soft(bobRows.map((row) => row.type)).not.toContain("Sick");
      expect.soft(bobRows.map((row) => row.status)).not.toContain("Rejected");
      for (const row of bobRows) expect.soft(row.note).toBe("");
      for (const secret of BOB_PRIVATE_STRINGS) expect.soft(text).not.toContain(secret);
    });

    it("exports no teammate rows at all when filtered to Sick", async () => {
      const { detail } = await exportWorkbook(s.carol.id, {
        groupIds: [s.team],
        types: [CalendarRecordType.Sick],
      });

      expect.soft(detail.filter((row) => row.name === s.bob.name)).toEqual([]);
    });

    it("exports none of a teammate's private details from a mixed-group export", async () => {
      const { detail, text } = await exportWorkbook(s.carol.id);
      const bobRows = detail.filter((row) => row.name === s.bob.name);

      expect.soft(bobRows.map((row) => row.type)).not.toContain("Sick");
      expect.soft(bobRows.map((row) => row.status)).not.toContain("Rejected");
      for (const secret of BOB_PRIVATE_STRINGS) expect.soft(text).not.toContain(secret);
    });
  });

  describe("what stays for a teammate", () => {
    it("keeps a teammate's Sick day in the overview, the member report and the export", async () => {
      const all = await overview(s.carol.id);
      expect(usageOf(all.monthly, s.bob.id, CalendarRecordType.SickDay)).not.toEqual([]);

      const report = await memberReport(s.carol.id, s.bob.id);
      expect(report.bookings.map((b) => b.vacationType)).toContain(CalendarRecordType.SickDay);

      const { detail } = await exportWorkbook(s.carol.id, { groupIds: [s.team] });
      expect(detail.filter((row) => row.name === s.bob.name).map((row) => row.type)).toContain(
        "Sick day"
      );
    });

    it("keeps the viewer's own Sick, notes and rejected rows complete", async () => {
      const all = await overview(s.carol.id);
      expect(usageOf(all.monthly, s.carol.id, CalendarRecordType.Sick)).not.toEqual([]);

      const report = await memberReport(s.carol.id, s.carol.id);
      expect(report.bookings).toContainEqual(
        expect.objectContaining({
          vacationType: CalendarRecordType.Sick,
          note: "carol-own-sick-note",
        })
      );
      expect(report.bookings).toContainEqual(
        expect.objectContaining({ status: "rejected", note: "carol-own-rejected-note" })
      );

      const { detail } = await exportWorkbook(s.carol.id, { groupIds: [s.team] });
      const own = detail.filter((row) => row.name === s.carol.name);
      expect(own).toContainEqual(
        expect.objectContaining({ type: "Sick", note: "carol-own-sick-note" })
      );
      expect(own).toContainEqual(
        expect.objectContaining({ status: "Rejected", note: "carol-own-rejected-note" })
      );
    });

    it("keeps everything for the group the viewer administers in a mixed-group export", async () => {
      const { detail } = await exportWorkbook(s.carol.id);
      const danRows = detail.filter((row) => row.name === s.dan.name);

      expect(danRows).toContainEqual(
        expect.objectContaining({ group: "Side", type: "Sick", note: "dan-sick-note" })
      );
      expect(danRows).toContainEqual(
        expect.objectContaining({ status: "Rejected", note: "dan-rejected-note" })
      );
    });
  });

  describe("a group admin who is a member of the group keeps everything", () => {
    it("sees the member's Sick usage, notes and rejected bookings in the report", async () => {
      const all = await overview(s.carol.id, { groupIds: s.side });
      expect(usageOf(all.monthly, s.dan.id, CalendarRecordType.Sick)).not.toEqual([]);

      const report = await memberReport(s.carol.id, s.dan.id);
      expect(usageOf(report.monthly, s.dan.id, CalendarRecordType.Sick)).not.toEqual([]);
      expect(report.bookings).toContainEqual(
        expect.objectContaining({ vacationType: CalendarRecordType.Sick, note: "dan-sick-note" })
      );
      expect(report.bookings).toContainEqual(
        expect.objectContaining({ status: "rejected", note: "dan-rejected-note" })
      );
    });
  });

  describe("privileged readers of the member's own group keep everything", () => {
    const privileged: [string, (seeded: Seeded) => { id: string }][] = [
      ["the approver", (seeded) => seeded.ann],
      ["the manager without a membership row", (seeded) => seeded.mia],
      ["an org admin who isn't a member", (seeded) => seeded.owner],
    ];

    it.each(privileged)("%s sees the member's Sick usage in the overview", async (_, pick) => {
      const all = await overview(pick(s).id);
      expect(usageOf(all.monthly, s.bob.id, CalendarRecordType.Sick)).not.toEqual([]);
    });

    it.each(privileged)(
      "%s gets Sick, notes and rejected bookings in the member report",
      async (_, pick) => {
        const report = await memberReport(pick(s).id, s.bob.id);

        expect(report.bookings).toContainEqual(
          expect.objectContaining({ vacationType: CalendarRecordType.Sick, note: "bob-sick-note" })
        );
        expect(report.bookings).toContainEqual(
          expect.objectContaining({ status: "rejected", note: "bob-rejected-note" })
        );
      }
    );

    it.each(privileged)("%s exports Sick, notes and rejected rows", async (_, pick) => {
      const { detail } = await exportWorkbook(pick(s).id, { groupIds: [s.team] });
      const bobRows = detail.filter((row) => row.name === s.bob.name);

      expect(bobRows).toContainEqual(
        expect.objectContaining({ type: "Sick", note: "bob-sick-note" })
      );
      expect(bobRows).toContainEqual(
        expect.objectContaining({ status: "Rejected", note: "bob-rejected-note" })
      );
    });
  });
});
