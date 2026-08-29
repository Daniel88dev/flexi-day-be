import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import type { Express } from "express";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { reportExports } from "../../db/schema/report-export-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addChange,
  addLeave,
  addLeaveRange,
  addMember,
  addQuota,
  dayIn,
  makeGroup,
  makeUser,
  removeMember,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { and, eq } from "drizzle-orm";

const CURRENT_YEAR = new Date().getFullYear();
// A year wholly in the past makes every booking "used to date", and one wholly
// ahead makes every booking "planned" — no dependence on today's date within
// the year, so the split assertions stay deterministic whenever they run.
const PAST_YEAR = CURRENT_YEAR - 1;
const FUTURE_YEAR = CURRENT_YEAR + 1;

type Summary = {
  userId: string;
  groupId: string;
  vacationType: string;
  carriedOverDays: number;
  yearQuota: number;
  usedToDate: number;
  plannedRemaining: number;
  pending: number;
  remaining: number;
};

type Monthly = {
  userId: string;
  month: number;
  vacationType: string;
  used: number;
  pending: number;
};

const vacationSummaryFor = (summary: Summary[], userId: string) =>
  summary.find((row) => row.userId === userId && row.vacationType === CalendarRecordType.Vacation);

describe("Report API E2E", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await resetReportData();
  });

  describe("GET /api/reports/scope", () => {
    it("rejects an unauthenticated caller", async () => {
      await request(app).get("/api/reports/scope").expect(401);
    });

    it("grants full access to a member with view access", async () => {
      const manager = await makeUser("Manager");
      const viewer = await makeUser("Viewer");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, viewer.id, { viewAccess: true });

      const res = await request(app)
        .get("/api/reports/scope")
        .set("Cookie", await authCookieFor(viewer.id))
        .expect(200);

      expect(res.body.groups).toEqual([
        { groupId, groupName: "Engineering", access: "all", canEditQuotas: false },
      ]);
    });

    it("limits a plain member to their own rows", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, member.id);

      const res = await request(app)
        .get("/api/reports/scope")
        .set("Cookie", await authCookieFor(member.id))
        .expect(200);

      expect(res.body.groups[0]).toMatchObject({ access: "self", canEditQuotas: false });
    });

    it("lets a group admin edit quotas", async () => {
      const manager = await makeUser("Manager");
      const admin = await makeUser("Admin");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, admin.id, { adminAccess: true });

      const res = await request(app)
        .get("/api/reports/scope")
        .set("Cookie", await authCookieFor(admin.id))
        .expect(200);

      expect(res.body.groups[0]).toMatchObject({ access: "all", canEditQuotas: true });
    });

    it("treats the group manager as a full-access admin without extra flags", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);

      const res = await request(app)
        .get("/api/reports/scope")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.groups[0]).toMatchObject({ access: "all", canEditQuotas: true });
    });

    it("lists every colleague to a viewer but only themselves to a plain member", async () => {
      const manager = await makeUser("Manager");
      const viewer = await makeUser("Viewer");
      const colleague = await makeUser("Colleague");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, viewer.id, { viewAccess: true });
      await addMember(groupId, colleague.id);

      const viewerRes = await request(app)
        .get("/api/reports/scope")
        .set("Cookie", await authCookieFor(viewer.id))
        .expect(200);
      const colleagueRes = await request(app)
        .get("/api/reports/scope")
        .set("Cookie", await authCookieFor(colleague.id))
        .expect(200);

      expect(viewerRes.body.members.map((m: { name: string }) => m.name).sort()).toEqual([
        "Colleague",
        "Viewer",
      ]);
      expect(colleagueRes.body.members.map((m: { name: string }) => m.name)).toEqual(["Colleague"]);
    });

    it("returns an empty scope rather than an error for a user in no group", async () => {
      const loner = await makeUser("Loner");

      const res = await request(app)
        .get("/api/reports/scope")
        .set("Cookie", await authCookieFor(loner.id))
        .expect(200);

      expect(res.body).toEqual({ groups: [], members: [], years: [CURRENT_YEAR] });
    });

    it("offers every year holding data, current year included", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addLeave(groupId, manager.id, dayIn(PAST_YEAR, 3, 10));

      const res = await request(app)
        .get("/api/reports/scope")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.years).toEqual([CURRENT_YEAR, PAST_YEAR]);
    });
  });

  describe("GET /api/reports/overview", () => {
    it("rejects an unauthenticated caller", async () => {
      await request(app).get("/api/reports/overview").expect(401);
    });

    it("aggregates approved and pending days into the right months", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addLeaveRange(groupId, manager.id, [
        dayIn(FUTURE_YEAR, 3, 10),
        dayIn(FUTURE_YEAR, 3, 11),
      ]);
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 5, 4), { approved: false });

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: FUTURE_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const monthly = res.body.monthly as Monthly[];
      expect(monthly.find((r) => r.month === 3)).toMatchObject({ used: 2, pending: 0 });
      expect(monthly.find((r) => r.month === 5)).toMatchObject({ used: 0, pending: 1 });
    });

    it("counts a half day as 0.5", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 3, 10), { halfDay: true });
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 3, 11));

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: FUTURE_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect((res.body.monthly as Monthly[]).find((r) => r.month === 3)?.used).toBe(1.5);
    });

    it("excludes rejected leave from both buckets", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 3, 10), {
        approved: false,
        rejected: true,
      });

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: FUTURE_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const march = (res.body.monthly as Monthly[]).find((r) => r.month === 3);
      expect(march).toMatchObject({ used: 0, pending: 0 });
    });

    it("splits a past year into used-to-date and a future year into planned", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addLeave(groupId, manager.id, dayIn(PAST_YEAR, 6, 10));
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 6, 10));

      const cookie = await authCookieFor(manager.id);
      const past = await request(app)
        .get("/api/reports/overview")
        .query({ year: PAST_YEAR })
        .set("Cookie", cookie)
        .expect(200);
      const future = await request(app)
        .get("/api/reports/overview")
        .query({ year: FUTURE_YEAR })
        .set("Cookie", cookie)
        .expect(200);

      expect(vacationSummaryFor(past.body.summary, manager.id)).toMatchObject({
        usedToDate: 1,
        plannedRemaining: 0,
      });
      expect(vacationSummaryFor(future.body.summary, manager.id)).toMatchObject({
        usedToDate: 0,
        plannedRemaining: 1,
      });
    });

    it("adds carry-over to the remaining allowance", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addQuota(groupId, manager.id, PAST_YEAR, { vacationDays: 20, carriedOverDays: 3 });
      await addLeave(groupId, manager.id, dayIn(PAST_YEAR, 6, 10));

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: PAST_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(vacationSummaryFor(res.body.summary, manager.id)).toMatchObject({
        carriedOverDays: 3,
        yearQuota: 20,
        usedToDate: 1,
        remaining: 22,
      });
    });

    it("includes a member who has an allowance but has booked nothing", async () => {
      const manager = await makeUser("Manager");
      const idle = await makeUser("Idle Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addMember(groupId, idle.id);
      await addQuota(groupId, idle.id, CURRENT_YEAR, { vacationDays: 25 });

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(vacationSummaryFor(res.body.summary, idle.id)).toMatchObject({
        yearQuota: 25,
        usedToDate: 0,
        remaining: 25,
      });
    });

    it("hides a colleague's rows from a plain member", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const colleague = await makeUser("Colleague");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, member.id);
      await addMember(groupId, colleague.id);
      await addLeave(groupId, member.id, dayIn(FUTURE_YEAR, 3, 10));
      await addLeave(groupId, colleague.id, dayIn(FUTURE_YEAR, 3, 11));

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: FUTURE_YEAR })
        .set("Cookie", await authCookieFor(member.id))
        .expect(200);

      const owners = new Set((res.body.monthly as Monthly[]).map((r) => r.userId));
      expect(Array.from(owners)).toEqual([member.id]);
    });

    it("narrows to the requested leave types", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 3, 10));
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 3, 11), {
        type: CalendarRecordType.Sick,
      });

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: FUTURE_YEAR, types: CalendarRecordType.Sick })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect((res.body.monthly as Monthly[]).map((r) => r.vacationType)).toEqual([
        CalendarRecordType.Sick,
      ]);
    });

    it("narrows to the requested groups", async () => {
      const manager = await makeUser("Manager");
      const groupA = await makeGroup("Engineering", manager.id);
      const groupB = await makeGroup("Design", manager.id);
      await addMember(groupA, manager.id);
      await addMember(groupB, manager.id);
      await addLeave(groupA, manager.id, dayIn(FUTURE_YEAR, 3, 10));
      await addLeave(groupB, manager.id, dayIn(FUTURE_YEAR, 4, 10));

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: FUTURE_YEAR, groupIds: groupB })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect((res.body.monthly as Monthly[]).map((r) => r.month)).toEqual([4]);
    });

    it("returns nothing when the requested group is outside the caller's scope", async () => {
      const manager = await makeUser("Manager");
      const outsider = await makeUser("Outsider");
      const mine = await makeGroup("Engineering", manager.id);
      const theirs = await makeGroup("Secret", outsider.id);
      await addMember(mine, manager.id);
      await addMember(theirs, outsider.id);
      await addLeave(theirs, outsider.id, dayIn(FUTURE_YEAR, 3, 10));

      const res = await request(app)
        .get("/api/reports/overview")
        .query({ year: FUTURE_YEAR, groupIds: theirs })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.monthly).toEqual([]);
      expect(res.body.summary).toEqual([]);
    });
  });

  describe("GET /api/reports/members/:userId", () => {
    it("rejects an unauthenticated caller", async () => {
      const target = await makeUser("Target");
      await request(app).get(`/api/reports/members/${target.id}`).expect(401);
    });

    it("lets a plain member open their own detail", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, member.id);

      const res = await request(app)
        .get(`/api/reports/members/${member.id}`)
        .query({ year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(member.id))
        .expect(200);

      expect(res.body.member).toMatchObject({ id: member.id, name: "Member" });
    });

    it("refuses a member the caller shares no group with", async () => {
      const manager = await makeUser("Manager");
      const stranger = await makeUser("Stranger");
      const groupId = await makeGroup("Engineering", manager.id);
      const otherGroup = await makeGroup("Elsewhere", stranger.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addMember(otherGroup, stranger.id);

      await request(app)
        .get(`/api/reports/members/${stranger.id}`)
        .query({ year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(403);
    });

    it("refuses a colleague's detail to a member with only self access", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const colleague = await makeUser("Colleague");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, member.id);
      await addMember(groupId, colleague.id);

      await request(app)
        .get(`/api/reports/members/${colleague.id}`)
        .query({ year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(member.id))
        .expect(403);
    });

    it("collapses contiguous days into one booking with a weighted day count", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addLeaveRange(groupId, manager.id, [
        dayIn(FUTURE_YEAR, 3, 10),
        dayIn(FUTURE_YEAR, 3, 11),
        dayIn(FUTURE_YEAR, 3, 12),
      ]);
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 3, 20), { halfDay: true });

      const res = await request(app)
        .get(`/api/reports/members/${manager.id}`)
        .query({ year: FUTURE_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.bookings).toHaveLength(2);
      expect(res.body.bookings[0]).toMatchObject({
        from: dayIn(FUTURE_YEAR, 3, 10),
        to: dayIn(FUTURE_YEAR, 3, 12),
        days: 3,
        status: "approved",
      });
      expect(res.body.bookings[1]).toMatchObject({ days: 0.5 });
    });

    it("returns the admin change log newest first with who made each change", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addMember(groupId, member.id);
      const earlier = new Date();
      const later = new Date(earlier.getTime() + 1000);
      await addChange(groupId, member.id, manager.id, "Quota for X: vacation 20 → 22", earlier);
      await addChange(groupId, member.id, manager.id, "Quota for X: carried over 0 → 3", later);

      const res = await request(app)
        .get(`/api/reports/members/${member.id}`)
        .query({ year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.changes).toHaveLength(2);
      expect(res.body.changes[0].changeDetail).toBe("Quota for X: carried over 0 → 3");
      expect(res.body.changes[0].actor).toMatchObject({ id: manager.id, name: "Manager" });
    });

    it("leaves out changes recorded in another year", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addMember(groupId, member.id);
      await addChange(groupId, member.id, manager.id, "This year's change");

      const res = await request(app)
        .get(`/api/reports/members/${member.id}`)
        .query({ year: FUTURE_YEAR })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.changes).toEqual([]);
    });
  });

  describe("POST /api/reports/export", () => {
    it("rejects an unauthenticated caller", async () => {
      await request(app).post("/api/reports/export").send({ year: CURRENT_YEAR }).expect(401);
    });

    it("returns an xlsx attachment", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 3, 10));

      const res = await request(app)
        .post("/api/reports/export")
        .set("Cookie", await authCookieFor(manager.id))
        .send({ year: FUTURE_YEAR })
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers["content-type"]).toContain("spreadsheetml.sheet");
      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="flexi-day-report-${FUTURE_YEAR.toString()}.xlsx"`
      );
      // Every xlsx is a zip archive, so the body must start with the PK magic.
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    });

    it("names a member who has since left the group on the summary sheet", async () => {
      const manager = await makeUser("Manager");
      const leaver = await makeUser("Priya Leaver");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addMember(groupId, leaver.id);
      await addQuota(groupId, leaver.id, FUTURE_YEAR, { vacationDays: 20 });
      await addLeave(groupId, leaver.id, dayIn(FUTURE_YEAR, 3, 10));

      // Their quota and bookings outlive the membership, so they still earn a
      // summary line — one that used to print the raw user id.
      await removeMember(groupId, leaver.id);

      const res = await request(app)
        .post("/api/reports/export")
        .set("Cookie", await authCookieFor(manager.id))
        .send({ year: FUTURE_YEAR })
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body as ArrayBuffer);
      const names = new Set<string>();
      workbook.getWorksheet(`Summary ${FUTURE_YEAR.toString()}`)?.eachRow((row, index) => {
        if (index > 1) names.add(String(row.getCell(1).value));
      });

      expect(names).toContain("Priya Leaver");
      expect(names).not.toContain(leaver.id);
    });

    it("records who generated the export, for which year and with which filters", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addLeaveRange(groupId, manager.id, [
        dayIn(FUTURE_YEAR, 3, 10),
        dayIn(FUTURE_YEAR, 3, 11),
      ]);

      await request(app)
        .post("/api/reports/export")
        .set("Cookie", await authCookieFor(manager.id))
        .send({ year: FUTURE_YEAR, groupIds: [groupId], types: [CalendarRecordType.Vacation] })
        .buffer(true)
        .parse((response, callback) => {
          response.on("data", () => undefined);
          response.on("end", () => callback(null, null));
        })
        .expect(200);

      const audit = await db.select().from(reportExports);

      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        userId: manager.id,
        relatedYear: FUTURE_YEAR.toString(),
        // The two contiguous days collapse into one booking row.
        rowCount: 1,
      });
      expect(audit[0]?.filters).toMatchObject({
        year: FUTURE_YEAR,
        groupIds: [groupId],
        types: [CalendarRecordType.Vacation],
      });
    });

    it("rejects a year outside the supported range", async () => {
      const manager = await makeUser("Manager");

      await request(app)
        .post("/api/reports/export")
        .set("Cookie", await authCookieFor(manager.id))
        .send({ year: 1999 })
        .expect(422);
    });

    it("rejects bank holiday as a type filter", async () => {
      const manager = await makeUser("Manager");

      await request(app)
        .post("/api/reports/export")
        .set("Cookie", await authCookieFor(manager.id))
        .send({ year: FUTURE_YEAR, types: [CalendarRecordType.BankHoliday] })
        .expect(422);
    });

    it("keeps bank holiday rows out of the workbook even without a type filter", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { viewAccess: true });
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 3, 10));
      await addLeave(groupId, manager.id, dayIn(FUTURE_YEAR, 5, 1), {
        type: CalendarRecordType.BankHoliday,
      });

      const res = await request(app)
        .post("/api/reports/export")
        .set("Cookie", await authCookieFor(manager.id))
        .send({ year: FUTURE_YEAR })
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body as ArrayBuffer);
      const types = new Set<string>();
      workbook.getWorksheet("Detail")?.eachRow((row, index) => {
        if (index > 1) types.add(String(row.getCell(3).value));
      });

      expect(types).toContain("Vacation");
      expect(types).not.toContain("Bank Holiday");
    });
  });

  describe("GET /api/quotas/:groupId/carryover-suggestion", () => {
    it("refuses a caller without admin access", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, member.id, { viewAccess: true });

      await request(app)
        .get(`/api/quotas/${groupId}/carryover-suggestion`)
        .query({ userId: member.id, year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(member.id))
        .expect(403);
    });

    it("suggests last year's unused allowance, counting pending days as spent", async () => {
      const admin = await makeUser("Admin");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", admin.id);
      await addMember(groupId, admin.id, { adminAccess: true });
      await addMember(groupId, member.id);
      await addQuota(groupId, member.id, PAST_YEAR, { vacationDays: 20, carriedOverDays: 2 });
      await addLeaveRange(groupId, member.id, [dayIn(PAST_YEAR, 3, 10), dayIn(PAST_YEAR, 3, 11)]);
      await addLeave(groupId, member.id, dayIn(PAST_YEAR, 4, 1), { approved: false });

      const res = await request(app)
        .get(`/api/quotas/${groupId}/carryover-suggestion`)
        .query({ userId: member.id, year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(admin.id))
        .expect(200);

      expect(res.body).toMatchObject({
        previousYear: PAST_YEAR,
        allocated: 22,
        used: 3,
        suggestion: 19,
      });
    });

    it("never suggests a negative carry-over", async () => {
      const admin = await makeUser("Admin");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", admin.id);
      await addMember(groupId, admin.id, { adminAccess: true });
      await addMember(groupId, member.id);
      await addQuota(groupId, member.id, PAST_YEAR, { vacationDays: 1 });
      await addLeaveRange(groupId, member.id, [
        dayIn(PAST_YEAR, 3, 10),
        dayIn(PAST_YEAR, 3, 11),
        dayIn(PAST_YEAR, 3, 12),
      ]);

      const res = await request(app)
        .get(`/api/quotas/${groupId}/carryover-suggestion`)
        .query({ userId: member.id, year: CURRENT_YEAR })
        .set("Cookie", await authCookieFor(admin.id))
        .expect(200);

      expect(res.body.suggestion).toBe(0);
    });
  });

  describe("PUT /api/quotas/:groupId with carry-over", () => {
    it("stores the carry-over and records it in the audit log", async () => {
      const admin = await makeUser("Admin");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", admin.id);
      await addMember(groupId, admin.id, { adminAccess: true });
      await addMember(groupId, member.id);

      await request(app)
        .put(`/api/quotas/${groupId}`)
        .set("Cookie", await authCookieFor(admin.id))
        .send({
          userId: member.id,
          year: CURRENT_YEAR,
          vacationDays: 25,
          homeOfficeDays: 5,
          carriedOverDays: 4,
        })
        .expect(200);

      const [quota] = await db
        .select()
        .from(userYearQuotas)
        .where(
          and(
            eq(userYearQuotas.userId, member.id),
            eq(userYearQuotas.relatedYear, CURRENT_YEAR.toString())
          )
        );
      const audit = await db
        .select()
        .from(changesSchema)
        .where(eq(changesSchema.userId, member.id));

      expect(quota).toMatchObject({ vacationDays: 25, homeOfficeDays: 5, carriedOverDays: 4 });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.changeDetail).toContain("4 carried over from the previous year");
      expect(audit[0]?.changingUserId).toBe(admin.id);
    });

    it("names only what moved when an existing allowance is edited", async () => {
      const admin = await makeUser("Admin");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", admin.id);
      await addMember(groupId, admin.id, { adminAccess: true });
      await addMember(groupId, member.id);
      await addQuota(groupId, member.id, CURRENT_YEAR, {
        vacationDays: 20,
        homeOfficeDays: 5,
        carriedOverDays: 0,
      });

      await request(app)
        .put(`/api/quotas/${groupId}`)
        .set("Cookie", await authCookieFor(admin.id))
        .send({
          userId: member.id,
          year: CURRENT_YEAR,
          vacationDays: 20,
          homeOfficeDays: 5,
          carriedOverDays: 3,
        })
        .expect(200);

      const audit = await db
        .select()
        .from(changesSchema)
        .where(eq(changesSchema.userId, member.id));

      expect(audit[0]?.changeDetail).toBe(
        `Quota for ${CURRENT_YEAR.toString()}: carried over 0 → 3`
      );
    });

    it("refuses a quota edit from a member without admin access", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, member.id, { viewAccess: true });

      await request(app)
        .put(`/api/quotas/${groupId}`)
        .set("Cookie", await authCookieFor(member.id))
        .send({
          userId: member.id,
          year: CURRENT_YEAR,
          vacationDays: 99,
          homeOfficeDays: 0,
          carriedOverDays: 0,
        })
        .expect(403);
    });
  });
});
