import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { vacation, CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { session } from "../../db/schema/auth-schema.js";
import {
  cleanupTestData,
  createTestGroup,
  createTestUser,
  type TestGroup,
  type TestUser,
} from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { setMirrorsIntoGroupForUser } from "../../services/groupMirror/groupMirrorServices.js";
import type { PendingApprovalEntry } from "../../services/vacation/collapsePendingApprovals.js";

describe("GET /api/users/me/pending-requests", () => {
  let server: LoopbackServer;
  let manager: TestUser;
  let mia: TestUser;
  let otto: TestUser;
  let teamA: TestGroup;
  let allEng: TestGroup;

  const addMember = (userId: string, groupId: string, approverAccess = false) =>
    db.insert(groupUsers).values({
      id: uuidv4(),
      userId,
      groupId,
      viewAccess: true,
      adminAccess: false,
      approverAccess,
      controlledUser: true,
    });

  const book = async (
    userId: string,
    groupId: string,
    day: string,
    stamps: Partial<typeof vacation.$inferInsert> = {}
  ) => {
    const id = uuidv4();
    await db.insert(vacation).values({
      id,
      userId,
      groupId,
      requestId: uuidv4(),
      requestedDay: day,
      vacationType: CalendarRecordType.Vacation,
      ...stamps,
    });
    return id;
  };

  const pendingRequestsOf = async (userId: string): Promise<PendingApprovalEntry[]> => {
    const response = await request(server.url)
      .get("/api/users/me/pending-requests")
      .set("Cookie", await authCookieFor(userId))
      .expect(200);
    return response.body as PendingApprovalEntry[];
  };

  const approvalsOf = async (userId: string): Promise<PendingApprovalEntry[]> => {
    const response = await request(server.url)
      .get("/api/users/me/approvals")
      .set("Cookie", await authCookieFor(userId))
      .expect(200);
    return response.body as PendingApprovalEntry[];
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());

    manager = await createTestUser("pending-manager@test.com", "Manager", "password123");
    mia = await createTestUser("pending-mia@test.com", "Mia Lind", "password123");
    otto = await createTestUser("pending-otto@test.com", "Otto Berg", "password123");

    teamA = await createTestGroup("Team A", manager.id, manager.id);
    allEng = await createTestGroup("All Engineering", manager.id, manager.id);

    await addMember(mia.id, teamA.id);
    await addMember(mia.id, allEng.id);
    await addMember(otto.id, teamA.id);
    await addMember(otto.id, allEng.id, true);
  });

  afterAll(async () => {
    await server?.close();
    await db.delete(groupMirrors);
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(vacation);
    await db.delete(groupMirrors);
    await db.delete(session);
  });

  it("returns a plain member's pending days collapsed into one range", async () => {
    const requestId = uuidv4();
    const ids = [
      await book(mia.id, teamA.id, "2026-03-09", { requestId }),
      await book(mia.id, teamA.id, "2026-03-10", { requestId }),
      await book(mia.id, teamA.id, "2026-03-11", { requestId }),
    ];

    const ranges = await pendingRequestsOf(mia.id);

    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      groupId: teamA.id,
      groupName: "Team A",
      vacationType: CalendarRecordType.Vacation,
      from: "2026-03-09",
      to: "2026-03-11",
      businessDays: 3,
    });
    expect(ranges[0]?.vacationIds).toEqual(ids);
  });

  it("keeps separate requests and groups apart", async () => {
    await book(mia.id, teamA.id, "2026-03-09");
    await book(mia.id, teamA.id, "2026-03-11");
    await book(mia.id, allEng.id, "2026-03-10");

    const ranges = await pendingRequestsOf(mia.id);

    expect(ranges.map(({ groupId, from, to }) => ({ groupId, from, to }))).toEqual(
      expect.arrayContaining([
        { groupId: teamA.id, from: "2026-03-09", to: "2026-03-09" },
        { groupId: teamA.id, from: "2026-03-11", to: "2026-03-11" },
        { groupId: allEng.id, from: "2026-03-10", to: "2026-03-10" },
      ])
    );
    expect(ranges).toHaveLength(3);
  });

  it("returns one item per request, across a weekend and apart from an adjacent request", async () => {
    const trip = uuidv4();
    const other = uuidv4();
    const tripIds = [
      await book(mia.id, teamA.id, "2026-12-24", { requestId: trip }),
      await book(mia.id, teamA.id, "2026-12-25", { requestId: trip }),
      await book(mia.id, teamA.id, "2026-12-28", { requestId: trip }),
    ];
    const otherIds = [await book(mia.id, teamA.id, "2026-12-29", { requestId: other })];

    const ranges = await pendingRequestsOf(mia.id);

    expect(
      ranges.map(({ vacationIds, from, to, businessDays }) => ({
        vacationIds,
        from,
        to,
        businessDays,
      }))
    ).toEqual([
      { vacationIds: tripIds, from: "2026-12-24", to: "2026-12-28", businessDays: 3 },
      { vacationIds: otherIds, from: "2026-12-29", to: "2026-12-29", businessDays: 1 },
    ]);
  });

  it("never returns decided, cancelled or other people's rows", async () => {
    await book(mia.id, teamA.id, "2026-03-02", { approvedAt: new Date(), approvedBy: manager.id });
    await book(mia.id, teamA.id, "2026-03-03", { rejectedAt: new Date(), rejectedBy: manager.id });
    await book(mia.id, teamA.id, "2026-03-04", { deletedAt: new Date() });
    await book(otto.id, teamA.id, "2026-03-05");

    expect(await pendingRequestsOf(mia.id)).toEqual([]);
  });

  it("leaves out a request its owner may decide, which /me/approvals lists instead", async () => {
    const own = await book(otto.id, allEng.id, "2026-03-09");
    const waiting = await book(otto.id, teamA.id, "2026-03-10");

    const pending = await pendingRequestsOf(otto.id);
    const approvals = await approvalsOf(otto.id);

    expect(pending.flatMap((range) => range.vacationIds)).toEqual([waiting]);
    expect(approvals.flatMap((range) => range.vacationIds)).toEqual([own]);
  });

  it("returns an approver's own request in a group their records are mirrored into", async () => {
    await setMirrorsIntoGroupForUser(otto.id, allEng.id, [teamA.id], [teamA.id]);
    const own = await book(otto.id, allEng.id, "2026-03-09");

    const pending = await pendingRequestsOf(otto.id);
    const approvals = await approvalsOf(otto.id);

    expect(pending.flatMap((range) => range.vacationIds)).toEqual([own]);
    expect(approvals.flatMap((range) => range.vacationIds)).not.toContain(own);
  });

  it("returns the manager's own request, which they may not decide without approver access", async () => {
    const own = await book(manager.id, teamA.id, "2026-03-09");

    const pending = await pendingRequestsOf(manager.id);
    const approvals = await approvalsOf(manager.id);

    expect(pending.flatMap((range) => range.vacationIds)).toEqual([own]);
    expect(approvals.flatMap((range) => range.vacationIds)).not.toContain(own);
  });

  describe("GET /api/users/me/approvals", () => {
    const dashboardCountOf = async (userId: string): Promise<number> => {
      const response = await request(server.url)
        .get("/api/users/me/dashboard-summary")
        .set("Cookie", await authCookieFor(userId))
        .expect(200);
      return (response.body as { pendingApprovalsCount: number }).pendingApprovalsCount;
    };

    it("lists a request across a weekend as one item, and the dashboard counts one", async () => {
      const requestId = uuidv4();
      const ids = [
        await book(mia.id, teamA.id, "2026-12-24", { requestId, note: "Christmas" }),
        await book(mia.id, teamA.id, "2026-12-25", { requestId, note: "Christmas" }),
        await book(mia.id, teamA.id, "2026-12-28", { requestId, note: "Christmas" }),
      ];

      const approvals = await approvalsOf(manager.id);

      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        vacationIds: ids,
        from: "2026-12-24",
        to: "2026-12-28",
        businessDays: 3,
        note: "Christmas",
      });
      expect(await dashboardCountOf(manager.id)).toBe(1);
    });

    it("keeps two requests on adjacent days as two items with their own notes", async () => {
      const first = uuidv4();
      const second = uuidv4();
      const firstIds = [
        await book(mia.id, teamA.id, "2026-12-14", { requestId: first, note: "first" }),
        await book(mia.id, teamA.id, "2026-12-15", { requestId: first, note: "first" }),
      ];
      const secondIds = [
        await book(mia.id, teamA.id, "2026-12-16", { requestId: second, note: "second" }),
        await book(mia.id, teamA.id, "2026-12-17", { requestId: second, note: "second" }),
      ];

      const approvals = await approvalsOf(manager.id);

      expect(approvals.map(({ vacationIds, note }) => ({ vacationIds, note }))).toEqual([
        { vacationIds: firstIds, note: "first" },
        { vacationIds: secondIds, note: "second" },
      ]);
      expect(await dashboardCountOf(manager.id)).toBe(2);
    });

    it("covers only the pending days of a partly decided request", async () => {
      const requestId = uuidv4();
      const mon = await book(mia.id, teamA.id, "2026-12-14", { requestId });
      await book(mia.id, teamA.id, "2026-12-15", {
        requestId,
        approvedAt: new Date(),
        approvedBy: manager.id,
      });
      await book(mia.id, teamA.id, "2026-12-16", { requestId, deletedAt: new Date() });
      const thu = await book(mia.id, teamA.id, "2026-12-17", { requestId });

      const approvals = await approvalsOf(manager.id);

      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        vacationIds: [mon, thu],
        from: "2026-12-14",
        to: "2026-12-17",
        businessDays: 2,
      });
      expect(await dashboardCountOf(manager.id)).toBe(1);
    });
  });
});
