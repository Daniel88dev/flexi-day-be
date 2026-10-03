import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeaveRange,
  addMember,
  dayIn,
  enableSickDayBenefit,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

const CURRENT_YEAR = new Date().getFullYear();
// Wholly ahead, so every approved day is "planned" and the booking window
// (this year through the end of the next) still accepts it.
const FUTURE_YEAR = CURRENT_YEAR + 1;
const PAST_YEAR = CURRENT_YEAR - 1;

const firstMondayOfMarch = (year: number): Date => {
  const day = new Date(Date.UTC(year, 2, 1));
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  return day;
};
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const shift = (date: Date, days: number) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

type Summary = {
  userId: string;
  vacationType: string;
  carriedOverDays: number;
  yearQuota: number;
  usedToDate: number;
  plannedRemaining: number;
  pending: number;
  remaining: number;
};

type Bucket = { type: string; allocated: number; used: number; pending: number };

const setGroupDefaults = async (
  groupId: string,
  defaults: { vacation: number; homeOffice: number; sick: number }
) => {
  await db
    .update(groups)
    .set({
      defaultVacationDays: defaults.vacation,
      defaultHomeOfficeDays: defaults.homeOffice,
      defaultSickDays: defaults.sick,
    })
    .where(eq(groups.id, groupId));
};

describe("A member with no quota row", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  it("books up to the group default and then reads a remaining of zero everywhere", async () => {
    const manager = await makeUser("Manager");
    const member = await makeUser("Noa Norow");
    const groupId = await makeGroup("Engineering", manager.id);
    await enableSickDayBenefit(manager.id);
    await setGroupDefaults(groupId, { vacation: 2, homeOffice: 1, sick: 1 });
    await addMember(groupId, manager.id, { viewAccess: true, approverAccess: true });
    await addMember(groupId, member.id);

    const memberCookie = await authCookieFor(member.id);
    const managerCookie = await authCookieFor(manager.id);
    const monday = firstMondayOfMarch(FUTURE_YEAR);

    const booked = await request(server.url)
      .post("/api/vacation/create-vacation")
      .set("Cookie", memberCookie)
      .send({ groupId, from: isoDay(monday), to: isoDay(shift(monday, 1)) })
      .expect(201);

    // The guard bounds the missing row by the group default of 2.
    const refused = await request(server.url)
      .post("/api/vacation/create-vacation")
      .set("Cookie", memberCookie)
      .send({ groupId, from: isoDay(shift(monday, 2)), to: isoDay(shift(monday, 2)) })
      .expect(422);
    expect(refused.body).toMatchObject({
      errors: [{ context: { allocated: 2, exceededBy: 1 } }],
    });

    await request(server.url)
      .post("/api/vacation/approve")
      .set("Cookie", managerCookie)
      .send({ ids: (booked.body as { id: string }[]).map((row) => row.id) })
      .expect(200);

    const balances = await request(server.url)
      .get("/api/users/me/balances")
      .query({ year: FUTURE_YEAR })
      .set("Cookie", memberCookie)
      .expect(200);
    const buckets = balances.body.buckets as Bucket[];
    const bucket = (type: CalendarRecordType) => buckets.find((b) => b.type === type);

    expect(bucket(CalendarRecordType.Vacation)).toEqual({
      type: CalendarRecordType.Vacation,
      allocated: 2,
      used: 2,
      pending: 0,
    });
    expect(bucket(CalendarRecordType.HomeOffice)).toMatchObject({ allocated: 1 });
    expect(bucket(CalendarRecordType.SickDay)).toMatchObject({ allocated: 1 });

    const overview = await request(server.url)
      .get("/api/reports/overview")
      .query({ year: FUTURE_YEAR })
      .set("Cookie", managerCookie)
      .expect(200);
    const summaryFor = (summary: Summary[], type: CalendarRecordType) =>
      summary.find((row) => row.userId === member.id && row.vacationType === type);
    const overviewSummary = overview.body.summary as Summary[];

    expect(summaryFor(overviewSummary, CalendarRecordType.Vacation)).toMatchObject({
      carriedOverDays: 0,
      yearQuota: 2,
      usedToDate: 0,
      plannedRemaining: 2,
      remaining: 0,
    });
    expect(summaryFor(overviewSummary, CalendarRecordType.HomeOffice)).toMatchObject({
      yearQuota: 1,
      remaining: 1,
    });
    expect(summaryFor(overviewSummary, CalendarRecordType.SickDay)).toMatchObject({
      carriedOverDays: 0,
      yearQuota: 1,
      remaining: 1,
    });

    const detail = await request(server.url)
      .get(`/api/reports/members/${member.id}`)
      .query({ year: FUTURE_YEAR })
      .set("Cookie", managerCookie)
      .expect(200);
    const detailSummary = detail.body.summary as Summary[];
    for (const type of [
      CalendarRecordType.Vacation,
      CalendarRecordType.HomeOffice,
      CalendarRecordType.SickDay,
    ]) {
      expect(summaryFor(detailSummary, type)).toEqual(summaryFor(overviewSummary, type));
    }

    const exported = await request(server.url)
      .post("/api/reports/export")
      .set("Cookie", managerCookie)
      .send({ year: FUTURE_YEAR })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.body as ArrayBuffer);
    const sheetRows = new Map<string, number[]>();
    workbook.getWorksheet(`Summary ${FUTURE_YEAR.toString()}`)?.eachRow((row, index) => {
      if (index > 1 && String(row.getCell(1).value) === member.name) {
        sheetRows.set(
          String(row.getCell(3).value),
          [4, 5, 6, 7, 8, 9].map((cell) => Number(row.getCell(cell).value))
        );
      }
    });

    const asSheetRow = (entry: Summary | undefined) =>
      entry && [
        entry.carriedOverDays,
        entry.yearQuota,
        entry.usedToDate,
        entry.plannedRemaining,
        entry.pending,
        entry.remaining,
      ];
    expect(sheetRows.get("Vacation")).toEqual(
      asSheetRow(summaryFor(overviewSummary, CalendarRecordType.Vacation))
    );
    expect(sheetRows.get("Home Office")).toEqual(
      asSheetRow(summaryFor(overviewSummary, CalendarRecordType.HomeOffice))
    );
    expect(sheetRows.get("Sick Day")).toEqual(
      asSheetRow(summaryFor(overviewSummary, CalendarRecordType.SickDay))
    );
  });

  it("suggests a carry-over from the group default when last year has no row", async () => {
    const admin = await makeUser("Admin");
    const member = await makeUser("Member");
    const groupId = await makeGroup("Engineering", admin.id);
    await setGroupDefaults(groupId, { vacation: 10, homeOffice: 0, sick: 0 });
    await addMember(groupId, admin.id, { adminAccess: true });
    await addMember(groupId, member.id);
    await addLeaveRange(groupId, member.id, [
      dayIn(PAST_YEAR, 3, 10),
      dayIn(PAST_YEAR, 3, 11),
      dayIn(PAST_YEAR, 3, 12),
    ]);

    const res = await request(server.url)
      .get(`/api/quotas/${groupId}/carryover-suggestion`)
      .query({ userId: member.id, year: CURRENT_YEAR })
      .set("Cookie", await authCookieFor(admin.id))
      .expect(200);

    expect(res.body).toMatchObject({
      previousYear: PAST_YEAR,
      allocated: 10,
      used: 3,
      suggestion: 7,
    });
  });
});
