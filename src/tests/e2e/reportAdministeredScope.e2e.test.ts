import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";
import type { ReportScopeEntry } from "../../services/report/types.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addQuota,
  dayIn,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

const FUTURE_YEAR = new Date().getFullYear() + 1;

/** The owner administers "Support" through the organization without belonging to it. */
const seedOrganization = async () => {
  const owner = await makeUser("Olivia Owner");
  const dave = await makeUser("Dave Manager");
  const erin = await makeUser("Erin Member");
  const frank = await makeUser("Frank Member");

  const ownTeam = await makeGroup("Own Team", owner.id);
  await addMember(ownTeam, owner.id, { viewAccess: true, adminAccess: true });

  const support = await makeGroup("Support", dave.id, { organizationOwnerId: owner.id });
  await addMember(support, dave.id, { viewAccess: true, adminAccess: true });
  await addMember(support, erin.id);
  await addMember(support, frank.id);
  await addQuota(support, erin.id, FUTURE_YEAR, { vacationDays: 22 });
  await addQuota(support, frank.id, FUTURE_YEAR, { vacationDays: 18 });
  await addLeave(support, erin.id, dayIn(FUTURE_YEAR, 3, 10));
  await addLeave(support, frank.id, dayIn(FUTURE_YEAR, 4, 14), { approved: false });

  const organizationId = (await ensureOrganizationForUser(owner.id)).id;

  return { owner, dave, erin, frank, ownTeam, support, organizationId };
};

describe("Report scope for groups the viewer administers", () => {
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

  const scopeOf = async (userId: string) => {
    const res = await request(server.url)
      .get("/api/reports/scope")
      .set("Cookie", await authCookieFor(userId))
      .expect(200);
    return res.body as { groups: ReportScopeEntry[]; members: { id: string; groupId: string }[] };
  };

  describe("GET /api/reports/scope", () => {
    it("lists a group the org owner administers without belonging to it, in full and with quota editing", async () => {
      const { owner, dave, erin, frank, ownTeam, support } = await seedOrganization();

      const scope = await scopeOf(owner.id);

      expect(scope.groups).toEqual([
        { groupId: ownTeam, groupName: "Own Team", access: "all", canEditQuotas: true },
        { groupId: support, groupName: "Support", access: "all", canEditQuotas: true },
      ]);
      expect(
        scope.members
          .filter((member) => member.groupId === support)
          .map((member) => member.id)
          .sort()
      ).toEqual([dave.id, erin.id, frank.id].sort());
    });

    it("lists the groups of an organization a delegate administers without belonging to any", async () => {
      const { owner, support, ownTeam, organizationId } = await seedOrganization();
      const delegate = await makeUser("Dee Delegate");
      await grantOrganizationAdmin({
        organizationId,
        userId: delegate.id,
        grantedByUserId: owner.id,
      });

      const scope = await scopeOf(delegate.id);

      expect(
        scope.groups.map((group) => [group.groupId, group.access, group.canEditQuotas])
      ).toEqual([
        [ownTeam, "all", true],
        [support, "all", true],
      ]);
    });

    it("opens the whole group to an org admin who is a plain member without view access", async () => {
      const { owner, erin, frank, support, organizationId } = await seedOrganization();
      await grantOrganizationAdmin({ organizationId, userId: erin.id, grantedByUserId: owner.id });

      const scope = await scopeOf(erin.id);

      expect(scope.groups.find((group) => group.groupId === support)).toMatchObject({
        access: "all",
        canEditQuotas: true,
      });
      expect(scope.members.map((member) => member.id)).toContain(frank.id);
    });

    it("leaves a plain member without org standing limited to themselves", async () => {
      const { erin, support } = await seedOrganization();

      const scope = await scopeOf(erin.id);

      expect(scope.groups).toEqual([
        { groupId: support, groupName: "Support", access: "self", canEditQuotas: false },
      ]);
      expect(scope.members.map((member) => member.id)).toEqual([erin.id]);
    });

    it("leaves out a deleted group of the administered organization", async () => {
      const { owner, support } = await seedOrganization();
      await db.update(groups).set({ deletedAt: new Date() }).where(eq(groups.id, support));

      const scope = await scopeOf(owner.id);

      expect(scope.groups.map((group) => group.groupName)).toEqual(["Own Team"]);
    });
  });

  it("includes the administered group's members in the overview", async () => {
    const { owner, dave, erin, frank, support } = await seedOrganization();

    const res = await request(server.url)
      .get("/api/reports/overview")
      .query({ year: FUTURE_YEAR, groupIds: support })
      .set("Cookie", await authCookieFor(owner.id))
      .expect(200);

    const body = res.body as {
      monthly: { userId: string }[];
      summary: { userId: string; vacationType: string; yearQuota: number }[];
    };
    expect(new Set(body.monthly.map((row) => row.userId))).toEqual(new Set([erin.id, frank.id]));
    expect(
      body.summary
        .filter((row) => row.vacationType === CalendarRecordType.Vacation)
        .map((row) => [row.userId, row.yearQuota])
        .sort()
    ).toEqual(
      [
        [dave.id, 0],
        [erin.id, 22],
        [frank.id, 18],
      ].sort()
    );
  });

  it("opens the member report of someone in the administered group, with quota editing", async () => {
    const { owner, erin, support } = await seedOrganization();

    const res = await request(server.url)
      .get(`/api/reports/members/${erin.id}`)
      .query({ year: FUTURE_YEAR })
      .set("Cookie", await authCookieFor(owner.id))
      .expect(200);

    expect(res.body.member).toMatchObject({ id: erin.id });
    expect(res.body.groups).toEqual([
      { groupId: support, groupName: "Support", access: "all", canEditQuotas: true },
    ]);
    expect(res.body.bookings).toHaveLength(1);
  });

  it("carries the administered group's members in the export", async () => {
    const { owner } = await seedOrganization();

    const res = await request(server.url)
      .post("/api/reports/export")
      .set("Cookie", await authCookieFor(owner.id))
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
    const cellText: string[] = [];
    workbook.eachSheet((sheet) =>
      sheet.eachRow((row) => {
        row.eachCell((cell) => cellText.push(String(cell.value)));
      })
    );

    expect(cellText).toEqual(expect.arrayContaining(["Erin Member", "Frank Member", "Support"]));
  });

  describe("outside the report", () => {
    it("keeps the administered group out of the owner's sync pull", async () => {
      const { owner, ownTeam, support } = await seedOrganization();

      const res = await request(server.url)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(owner.id))
        .expect(200);

      const body = res.body as {
        groups: { id: string }[];
        groupUsers: { groupId: string }[];
        vacations: { groupId: string }[];
        userYearQuotas: { groupId: string }[];
      };
      expect(body.groups.map((group) => group.id)).toEqual([ownTeam]);
      for (const rows of [body.groupUsers, body.vacations, body.userYearQuotas]) {
        expect(rows.map((row) => row.groupId)).not.toContain(support);
      }
    });

    it("keeps the administered group's calendar closed to the owner", async () => {
      const { owner, support } = await seedOrganization();

      await request(server.url)
        .get("/api/vacation")
        .query({ year: FUTURE_YEAR, month: 3, groupId: support })
        .set("Cookie", await authCookieFor(owner.id))
        .expect(403);
    });
  });
});
