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
    const ids = [
      await book(mia.id, teamA.id, "2026-03-09"),
      await book(mia.id, teamA.id, "2026-03-10"),
      await book(mia.id, teamA.id, "2026-03-11"),
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

  it("splits ranges at a gap and keeps groups apart", async () => {
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
});
