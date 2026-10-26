import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupEvents } from "../../db/schema/group-event-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { vacationEvents, vacationEventType } from "../../db/schema/vacation-event-schema.js";
import {
  attendanceEvents,
  attendanceEventType,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { listAttendanceSessionEvents } from "../../services/attendance/attendanceCorrections.js";
import { getEmployment, syncEmployment } from "../../services/employment/employmentServices.js";
import {
  getGroupDetailForSupport,
  getOrganizationDetailForSupport,
  searchOrganizationsForSupport,
} from "../../services/support/supportServices.js";
import {
  notifyVacationComment,
  notifyVacationDecision,
  notifyVacationRequested,
} from "../../services/vacation/vacationNotifier.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addChange,
  addLeave,
  addMember,
  addQuota,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

type SentEmail = { to: string; template: string; data: Record<string, string> };
const sentEmails: SentEmail[] = [];
vi.mock("../../services/email/index.js", () => ({
  emailSender: {
    sendTemplated: (email: SentEmail) => {
      sentEmails.push(email);
      return Promise.resolve();
    },
  },
}));

const MEMBER = "Pin Jana Nováková";
const OWNER = "Pin Owner";
const YEAR = 2026;
const APPROVED_DAY = "2026-11-10";
const PENDING_DAY = "2026-11-11";

/**
 * Pins what every reader routed through the person-name helper shows for one
 * person today, so the account-deletion change can alter the helper and see
 * exactly which outputs move.
 */
describe("the person-name readers", () => {
  let server: LoopbackServer;
  let owner: { id: string; name: string };
  let member: { id: string; name: string };
  let organizationId: string;
  let groupId: string;
  let approvedId: string;
  let pendingId: string;
  let ownerCookie: string;
  let memberCookie: string;

  const asOwner = (path: string) => request(server.url).get(path).set("Cookie", ownerCookie);

  beforeAll(async () => {
    await resetReportData();
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    owner = await makeUser(OWNER);
    member = await makeUser(MEMBER);
    groupId = await makeGroup("Pin Team", owner.id);
    const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
    organizationId = group!.organizationId;

    await addMember(groupId, owner.id, { viewAccess: true, adminAccess: true });
    await addMember(groupId, member.id, { viewAccess: true });
    await syncEmployment(organizationId, owner.id);
    await syncEmployment(organizationId, member.id);

    await addQuota(groupId, member.id, YEAR);
    await addChange(groupId, member.id, owner.id, "Quota for Pin: carried over 0 → 2");
    approvedId = await addLeave(groupId, member.id, APPROVED_DAY, {
      approvedBy: owner.id,
      createdByUserId: owner.id,
    });
    pendingId = await addLeave(groupId, member.id, PENDING_DAY, { approved: false });
    await db.insert(vacationEvents).values({
      id: uuidv4(),
      vacationId: approvedId,
      eventType: vacationEventType.Approved,
      actorUserId: owner.id,
    });
    await db.insert(groupEvents).values({
      id: uuidv4(),
      groupId,
      createdByUserId: member.id,
      title: "Pin lunch",
      startDate: "2026-11-12",
      endDate: "2026-11-12",
    });
    await db.insert(inviteLink).values({
      id: uuidv4(),
      groupId,
      code: `PIN${uuidv4().slice(0, 8)}`,
      email: "pin-invitee@test.com",
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    ownerCookie = await authCookieFor(owner.id);
    memberCookie = await authCookieFor(member.id);
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
  });

  beforeEach(() => {
    sentEmails.length = 0;
  });

  describe("reports", () => {
    it("names the member in the report scope", async () => {
      const res = await asOwner("/api/reports/scope").expect(200);

      expect(res.body.members).toContainEqual(
        expect.objectContaining({ id: member.id, name: MEMBER })
      );
    });

    it("names the member, their bookings and the change's actor in the member report", async () => {
      const res = await asOwner(`/api/reports/members/${member.id}?year=${YEAR.toString()}`).expect(
        200
      );

      expect(res.body.member).toMatchObject({ id: member.id, name: MEMBER });
      expect(res.body.bookings.map((b: { userName: string }) => b.userName)).toEqual([
        MEMBER,
        MEMBER,
      ]);
      expect(res.body.changes[0].actor).toMatchObject({ id: owner.id, name: OWNER });
    });

    it("names the member on the export's summary sheet", async () => {
      const res = await request(server.url)
        .post("/api/reports/export")
        .set("Cookie", ownerCookie)
        .send({ year: YEAR })
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body as ArrayBuffer);
      const names: string[] = [];
      workbook.getWorksheet(`Summary ${YEAR.toString()}`)?.eachRow((row, index) => {
        if (index > 1) names.push(String(row.getCell(1).value));
      });

      expect(names).toContain(MEMBER);
    });
  });

  describe("calendars", () => {
    it("names the member on the group calendar", async () => {
      const res = await asOwner(
        `/api/vacation/calendar?year=${YEAR.toString()}&month=11&groupId=${groupId}`
      ).expect(200);

      const row = (res.body as { id: string; user: { name: string } }[]).find(
        (r) => r.id === approvedId
      );
      expect(row?.user.name).toBe(MEMBER);
    });

    it("titles the team feed's event with the member's name", async () => {
      const created = await request(server.url)
        .post("/api/calendar-sync")
        .set("Cookie", ownerCookie)
        .send({
          name: "Pin feed",
          scope: "TEAM",
          teamIds: [groupId],
          types: [{ type: "VACATION", color: "blue" }],
        })
        .expect(201);
      const token = /\/calendars\/(flx_live_[a-f0-9]{40})\.ics$/.exec(
        created.body.feedUrl as string
      )![1]!;

      const feed = await request(server.url).get(`/calendars/${token}.ics`).expect(200);

      expect(feed.text).toContain(`SUMMARY:${MEMBER} — Vacation`);
    });

    it("names the creator of a group event", async () => {
      const res = await asOwner(
        `/api/group-events?year=${YEAR.toString()}&month=11&groupId=${groupId}`
      ).expect(200);

      expect(res.body[0].createdBy).toMatchObject({ id: member.id, name: MEMBER });
    });
  });

  describe("vacation timelines", () => {
    it("names the requester, the approver and the timeline's actor on the detail", async () => {
      const res = await asOwner(`/api/vacation/${approvedId}`).expect(200);

      expect(res.body.user.name).toBe(MEMBER);
      expect(res.body.approvedByUser.name).toBe(OWNER);
      expect(res.body.createdByUser.name).toBe(OWNER);
      expect(res.body.history[0].actor).toMatchObject({ id: owner.id, name: OWNER });
    });

    it("names the requester in the approver's queue and in their own pending list", async () => {
      const queue = await asOwner("/api/users/me/approvals").expect(200);
      const own = await request(server.url)
        .get("/api/users/me/pending-requests")
        .set("Cookie", memberCookie)
        .expect(200);

      expect(queue.body[0].user.name).toBe(MEMBER);
      expect(own.body[0].user.name).toBe(MEMBER);
    });
  });

  describe("member lists", () => {
    it("names the members of a group", async () => {
      const res = await asOwner(`/api/group-user/${groupId}`).expect(200);

      expect(
        (res.body as { userId: string; user: { name: string } }[]).map((m) => m.user.name)
      ).toEqual([OWNER, MEMBER].sort());
    });

    it("names the inviter on the group's open invites", async () => {
      const res = await asOwner(`/api/group-user/${groupId}/invites`).expect(200);

      expect(res.body[0].invitedByName).toBe(OWNER);
    });

    it("names the organization's people on the roster Team attendance reads", async () => {
      const res = await asOwner(`/api/employment/list?organizationId=${organizationId}`).expect(
        200
      );

      expect(
        (res.body as { userId: string; user: { name: string } }[]).map((e) => e.user.name)
      ).toEqual([OWNER, MEMBER].sort());
    });

    it("names who changed an attendance session on its timeline", async () => {
      const employment = await getEmployment(organizationId, member.id);
      const sessionId = uuidv4();
      await db.insert(attendanceSessions).values({
        id: sessionId,
        employmentId: employment!.id,
        businessDate: "2026-10-20",
        startedAt: new Date("2026-10-20T07:00:00Z"),
        timezone: "Europe/Prague",
      });
      await db.insert(attendanceEvents).values({
        id: uuidv4(),
        sessionId,
        eventType: attendanceEventType.ClockIn,
        changedByUserId: owner.id,
      });

      const timeline = await listAttendanceSessionEvents(owner.id, sessionId);

      expect(timeline[0]?.user).toMatchObject({ id: owner.id, name: OWNER });
    });

    it("names the owner among the organization's admins", async () => {
      const res = await asOwner("/api/organization").expect(200);

      expect(res.body.admins[0].user).toMatchObject({ id: owner.id, name: OWNER });
    });
  });

  describe("approval emails", () => {
    it("names the approver and the requester in the approval request", async () => {
      const [row] = await db.select().from(vacation).where(eq(vacation.id, pendingId));

      await notifyVacationRequested([row!], { id: member.id, name: MEMBER }, null);

      expect(sentEmails[0]?.data).toMatchObject({ approverName: OWNER, employeeName: MEMBER });
    });

    it("names the requester in the decision mail", async () => {
      const [row] = await db.select().from(vacation).where(eq(vacation.id, approvedId));

      await notifyVacationDecision([row!], "approved", { id: owner.id, name: OWNER });

      expect(sentEmails[0]?.data).toMatchObject({ employeeName: MEMBER, approverName: OWNER });
    });

    it("names the requester and the recipient in the comment mail", async () => {
      const [row] = await db.select().from(vacation).where(eq(vacation.id, approvedId));

      await notifyVacationComment(row!, { id: owner.id, name: OWNER }, "Enjoy");

      expect(sentEmails[0]?.data).toMatchObject({ recipientName: MEMBER, employeeName: MEMBER });
    });
  });

  describe("support pages", () => {
    it("names the owner in the organization search and detail", async () => {
      const found = await searchOrganizationsForSupport(OWNER);
      const detail = await getOrganizationDetailForSupport(organizationId);

      expect(found.map((o) => o.ownerName)).toEqual([OWNER]);
      expect(detail?.owner.name).toBe(OWNER);
    });

    it("names the members and the bookings in the group detail", async () => {
      const detail = await getGroupDetailForSupport(groupId);

      expect(detail?.members.map((m) => m.name)).toEqual([OWNER, MEMBER].sort());
      expect(new Set(detail?.vacations.map((v) => v.userName))).toEqual(new Set([MEMBER]));
    });
  });
});
