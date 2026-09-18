import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addMember,
  makeGroup,
  makeUser,
  removeMember,
  resetReportData,
} from "./helpers/reportFixtures.js";

const ENVELOPE_KEYS = [
  "cursor",
  "hasMore",
  "reset",
  "organizations",
  "users",
  "groups",
  "groupUsers",
  "groupMirrors",
  "userYearQuotas",
  "bankHolidays",
  "vacations",
];

type GroupUserRow = { id: string; groupId: string; organizationId: string; userId: string };
type GroupRow = { id: string; organizationId: string; groupName: string };

const organizationIdOf = async (userId: string): Promise<string> =>
  (await ensureOrganizationForUser(userId)).id;

describe("Sync pull E2E", () => {
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

  describe("GET /api/sync/pull", () => {
    it("rejects an unauthenticated caller", async () => {
      await request(app).get("/api/sync/pull").expect(401);
    });

    it("answers a sync reset with every table key in dependency order", async () => {
      const caller = await makeUser("Caller");

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect(res.headers["cache-control"]).toBe("no-store");
      expect(Object.keys(res.body)).toEqual(ENVELOPE_KEYS);
      expect(res.body.reset).toBe(true);
      expect(res.body.hasMore).toBe(false);
      expect(typeof res.body.cursor).toBe("string");
      expect(res.body.cursor.length).toBeGreaterThan(0);
    });

    it("leaves the tables this endpoint does not fill yet as empty arrays", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.users).toEqual([]);
      expect(res.body.groupMirrors).toEqual([]);
      expect(res.body.userYearQuotas).toEqual([]);
      expect(res.body.bankHolidays).toEqual([]);
      expect(res.body.vacations).toEqual([]);
    });

    // Cursors are minted but not read back yet, so a returned cursor is
    // accepted and answered with another snapshot rather than rejected.
    it("accepts a cursor and still answers a snapshot", async () => {
      const caller = await makeUser("Caller");
      const cookie = await authCookieFor(caller.id);

      const first = await request(app).get("/api/sync/pull").set("Cookie", cookie).expect(200);

      const second = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: first.body.cursor })
        .set("Cookie", cookie)
        .expect(200);

      expect(second.body.reset).toBe(true);
      expect(typeof second.body.cursor).toBe("string");
    });

    it("returns the full live member list of a group the caller sees in full", async () => {
      const manager = await makeUser("Manager");
      const viewer = await makeUser("Viewer");
      const member = await makeUser("Member");
      const leaver = await makeUser("Leaver");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, viewer.id, { viewAccess: true });
      await addMember(groupId, member.id);
      await addMember(groupId, leaver.id);
      await removeMember(groupId, leaver.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(viewer.id))
        .expect(200);

      const memberIds = (res.body.groupUsers as GroupUserRow[]).map((row) => row.userId).sort();
      expect(memberIds).toEqual([viewer.id, member.id].sort());
      expect((res.body.groups as GroupRow[]).map((row) => row.id)).toEqual([groupId]);
    });

    it("gives the manager the whole group without any access flag of their own", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addMember(groupId, member.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const memberIds = (res.body.groupUsers as GroupUserRow[]).map((row) => row.userId).sort();
      expect(memberIds).toEqual([manager.id, member.id].sort());
    });

    it("returns only the caller's own membership row in a self-scoped group", async () => {
      const manager = await makeUser("Manager");
      const plain = await makeUser("Plain");
      const other = await makeUser("Other");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, plain.id);
      await addMember(groupId, other.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(plain.id))
        .expect(200);

      const rows = res.body.groupUsers as GroupUserRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(plain.id);
      expect(rows[0]!.groupId).toBe(groupId);
    });

    it("omits a group the caller only administers as an org admin", async () => {
      const manager = await makeUser("Manager");
      const orgAdmin = await makeUser("Org Admin");
      const groupId = await makeGroup("Engineering", manager.id);
      const organizationId = await organizationIdOf(manager.id);
      await db.insert(organizationUsers).values({
        id: uuidv4(),
        organizationId,
        userId: orgAdmin.id,
        grantedByUserId: manager.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(orgAdmin.id))
        .expect(200);

      expect((res.body.groups as GroupRow[]).map((row) => row.id)).not.toContain(groupId);
      expect(res.body.groups).toEqual([]);
      expect(res.body.groupUsers).toEqual([]);
      expect(res.body.organizations).toEqual([]);
    });

    it("carries organizationId on every partitioned row and names each organization once", async () => {
      const manager = await makeUser("Manager");
      const otherManager = await makeUser("Other Manager");
      const caller = await makeUser("Caller");
      const firstGroup = await makeGroup("Engineering", manager.id);
      const secondGroup = await makeGroup("Support", manager.id);
      const foreignGroup = await makeGroup("Finance", otherManager.id);
      await addMember(firstGroup, caller.id, { viewAccess: true });
      await addMember(secondGroup, caller.id);
      await addMember(foreignGroup, caller.id);

      const managerOrgId = await organizationIdOf(manager.id);
      const otherOrgId = await organizationIdOf(otherManager.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      const groupRows = res.body.groups as GroupRow[];
      const memberRows = res.body.groupUsers as GroupUserRow[];
      expect(groupRows.map((row) => row.id).sort()).toEqual(
        [firstGroup, secondGroup, foreignGroup].sort()
      );
      for (const row of groupRows) expect(typeof row.organizationId).toBe("string");
      for (const row of memberRows) {
        const owningGroup = groupRows.find((group) => group.id === row.groupId);
        expect(row.organizationId).toBe(owningGroup!.organizationId);
      }

      const organizations = res.body.organizations as { id: string; name: string }[];
      expect(organizations.map((row) => row.id).sort()).toEqual([managerOrgId, otherOrgId].sort());
      for (const row of organizations) expect(typeof row.name).toBe("string");
    });

    it("serialises a group row with its raw columns and ISO timestamps", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      const [stored] = await db.select().from(groups).where(eq(groups.id, groupId));

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.groups).toEqual([
        {
          id: groupId,
          organizationId: stored!.organizationId,
          groupName: "Engineering",
          defaultVacationDays: stored!.defaultVacationDays,
          defaultHomeOfficeDays: stored!.defaultHomeOfficeDays,
          defaultSickDays: stored!.defaultSickDays,
          workingDays: stored!.workingDays,
          holidayCountry: null,
          managerUserId: manager.id,
          mainApprovalUser: null,
          tempApprovalUser: null,
          deletedAt: null,
          createdAt: stored!.createdAt.toISOString(),
          updatedAt: stored!.updatedAt.toISOString(),
        },
      ]);
    });
  });
});
