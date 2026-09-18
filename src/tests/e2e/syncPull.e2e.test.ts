import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { encodeSyncCursor } from "../../services/sync/syncCursor.js";
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

type GroupUserRow = {
  id: string;
  groupId: string;
  organizationId: string;
  userId: string;
  deletedAt: string | null;
  updatedAt: string;
};
type GroupRow = {
  id: string;
  organizationId: string;
  groupName: string;
  deletedAt: string | null;
  updatedAt: string;
};

const organizationIdOf = async (userId: string): Promise<string> =>
  (await ensureOrganizationForUser(userId)).id;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const ago = (ms: number): Date => new Date(Date.now() - ms);

/**
 * `updatedAt` is stamped by Drizzle in JavaScript, and an explicit value wins
 * over it, so a fixture can place a row on either side of a cursor.
 */
const setGroupUpdatedAt = async (groupId: string, updatedAt: Date): Promise<void> => {
  await db.update(groups).set({ updatedAt }).where(eq(groups.id, groupId));
};

const setMembershipUpdatedAt = async (
  groupId: string,
  userId: string,
  updatedAt: Date
): Promise<void> => {
  await db
    .update(groupUsers)
    .set({ updatedAt })
    .where(and(eq(groupUsers.groupId, groupId), eq(groupUsers.userId, userId)));
};

const membershipIdsOf = async (groupId: string): Promise<string[]> =>
  (
    await db.select({ id: groupUsers.id }).from(groupUsers).where(eq(groupUsers.groupId, groupId))
  ).map((row) => row.id);

/** Pushes every row of the fixture out of reach of any cursor the test mints. */
const ageEverything = async (): Promise<void> => {
  const longAgo = ago(365 * DAY);
  await db.update(groups).set({ updatedAt: longAgo });
  await db.update(groupUsers).set({ updatedAt: longAgo });
};

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

  describe("GET /api/sync/pull with a cursor", () => {
    it("answers a delta carrying only the rows changed since the cursor", async () => {
      const manager = await makeUser("Manager");
      const changed = await makeGroup("Engineering", manager.id);
      const untouched = await makeGroup("Support", manager.id);
      await addMember(changed, manager.id, { adminAccess: true });
      await addMember(untouched, manager.id, { adminAccess: true });
      await ageEverything();
      await setGroupUpdatedAt(changed, ago(1 * MINUTE));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.reset).toBe(false);
      expect(res.body.hasMore).toBe(false);
      const groupIds = (res.body.groups as GroupRow[]).map((row) => row.id);
      expect(groupIds).toEqual([changed]);
      expect(groupIds).not.toContain(untouched);
      expect(res.body.groupUsers).toEqual([]);
      expect(Object.keys(res.body)).toEqual(ENVELOPE_KEYS);
    });

    it("carries a cursor the next delta continues from", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await ageEverything();
      await setGroupUpdatedAt(groupId, ago(30 * MINUTE));
      const cookie = await authCookieFor(manager.id);

      const first = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(45 * MINUTE)) })
        .set("Cookie", cookie)
        .expect(200);

      const second = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: first.body.cursor })
        .set("Cookie", cookie)
        .expect(200);

      expect((first.body.groups as GroupRow[]).map((row) => row.id)).toEqual([groupId]);
      expect(second.body.reset).toBe(false);
      expect(second.body.groups).toEqual([]);
      expect(typeof second.body.cursor).toBe("string");
    });

    it("returns a row changed inside the 60 second overlap on two consecutive pulls", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await ageEverything();
      await setGroupUpdatedAt(groupId, ago(20 * SECOND));
      const cookie = await authCookieFor(manager.id);

      const first = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(30 * SECOND)) })
        .set("Cookie", cookie)
        .expect(200);

      const second = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: first.body.cursor })
        .set("Cookie", cookie)
        .expect(200);

      expect((first.body.groups as GroupRow[]).map((row) => row.id)).toEqual([groupId]);
      expect(second.body.groups).toEqual(first.body.groups);
    });

    it("orders each table by updatedAt then id", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const first = await makeGroup("First", manager.id);
      const second = await makeGroup("Second", manager.id);
      const third = await makeGroup("Third", manager.id);
      for (const groupId of [first, second, third]) {
        await addMember(groupId, manager.id, { adminAccess: true });
      }
      await addMember(first, member.id);
      await ageEverything();

      const tie = ago(2 * MINUTE);
      await setGroupUpdatedAt(first, tie);
      await setGroupUpdatedAt(second, tie);
      await setGroupUpdatedAt(third, ago(1 * MINUTE));
      await setMembershipUpdatedAt(first, manager.id, tie);
      await setMembershipUpdatedAt(first, member.id, tie);
      await setMembershipUpdatedAt(second, manager.id, ago(1 * MINUTE));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const tiedGroups = [first, second].sort();
      expect((res.body.groups as GroupRow[]).map((row) => row.id)).toEqual([...tiedGroups, third]);

      const tiedMemberships = (await membershipIdsOf(first)).sort();
      const [laterMembership] = await membershipIdsOf(second);
      expect((res.body.groupUsers as GroupUserRow[]).map((row) => row.id)).toEqual([
        ...tiedMemberships,
        laterMembership,
      ]);
    });

    it("names the organization of every group in the delta and no other", async () => {
      const manager = await makeUser("Manager");
      const otherManager = await makeUser("Other Manager");
      const caller = await makeUser("Caller");
      const changed = await makeGroup("Engineering", manager.id);
      const untouched = await makeGroup("Finance", otherManager.id);
      await addMember(changed, caller.id, { viewAccess: true });
      await addMember(untouched, caller.id, { viewAccess: true });
      await ageEverything();
      await setGroupUpdatedAt(changed, ago(1 * MINUTE));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      const organizations = res.body.organizations as { id: string; name: string }[];
      expect(organizations.map((row) => row.id)).toEqual([await organizationIdOf(manager.id)]);
      expect(organizations.map((row) => row.id)).not.toContain(
        await organizationIdOf(otherManager.id)
      );
    });

    it("keeps a membership of a group the caller only sees themselves in out of the delta", async () => {
      const manager = await makeUser("Manager");
      const plain = await makeUser("Plain");
      const other = await makeUser("Other");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, plain.id);
      await addMember(groupId, other.id);
      await ageEverything();
      await setMembershipUpdatedAt(groupId, other.id, ago(1 * MINUTE));
      await setMembershipUpdatedAt(groupId, plain.id, ago(2 * MINUTE));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(plain.id))
        .expect(200);

      const rows = res.body.groupUsers as GroupUserRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(plain.id);
    });

    // Stamped by hand rather than through `deleteGroup`, whose employment sweep
    // writes rows this suite does not clean up. What matters for the delta is
    // the shape that service leaves behind: the group soft-deleted, its
    // membership rows still live.
    it("returns a group soft-deleted since the cursor in full, with deletedAt set", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await ageEverything();
      const deletedAt = ago(1 * MINUTE);
      await db
        .update(groups)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(eq(groups.id, groupId));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const [stored] = await db.select().from(groups).where(eq(groups.id, groupId));
      expect(res.body.reset).toBe(false);
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
          deletedAt: deletedAt.toISOString(),
          createdAt: stored!.createdAt.toISOString(),
          updatedAt: deletedAt.toISOString(),
        },
      ]);
    });

    it("returns a membership removed since the cursor in full, with deletedAt set", async () => {
      const manager = await makeUser("Manager");
      const leaver = await makeUser("Leaver");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await addMember(groupId, leaver.id);
      await ageEverything();
      await removeMember(groupId, leaver.id);
      const removedAt = ago(1 * MINUTE);
      await db
        .update(groupUsers)
        .set({ deletedAt: removedAt, updatedAt: removedAt })
        .where(and(eq(groupUsers.groupId, groupId), eq(groupUsers.userId, leaver.id)));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      const [stored] = await db
        .select()
        .from(groupUsers)
        .where(and(eq(groupUsers.groupId, groupId), eq(groupUsers.userId, leaver.id)));
      expect(res.body.reset).toBe(false);
      expect(res.body.groupUsers).toEqual([
        {
          id: stored!.id,
          groupId,
          organizationId: await organizationIdOf(manager.id),
          userId: leaver.id,
          viewAccess: false,
          adminAccess: false,
          approverAccess: false,
          controlledUser: true,
          deletedAt: removedAt.toISOString(),
          createdAt: stored!.createdAt.toISOString(),
          updatedAt: removedAt.toISOString(),
        },
      ]);
    });

    it("answers a sync reset for a cursor it cannot decode", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await ageEverything();

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: "not-a-cursor" })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.reset).toBe(true);
      expect((res.body.groups as GroupRow[]).map((row) => row.id)).toEqual([groupId]);
      expect((res.body.groupUsers as GroupUserRow[]).map((row) => row.userId)).toEqual([
        manager.id,
      ]);
    });

    it("answers a sync reset for a cursor older than 30 days", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await ageEverything();

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(31 * DAY)) })
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.reset).toBe(true);
      expect((res.body.groups as GroupRow[]).map((row) => row.id)).toEqual([groupId]);
    });

    it("answers a sync reset for a cursor sent more than once", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await ageEverything();
      const cursor = encodeSyncCursor(ago(10 * MINUTE));

      const res = await request(app)
        .get(`/api/sync/pull?cursor=${cursor}&cursor=${cursor}`)
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.reset).toBe(true);
    });
  });
});
