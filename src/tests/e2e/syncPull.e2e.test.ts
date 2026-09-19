import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { decodeSyncCursor, encodeSyncCursor } from "../../services/sync/syncCursor.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addQuota,
  ageEverything,
  cancelLeave,
  dayIn,
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
type VacationRow = {
  id: string;
  userId: string;
  groupId: string;
  organizationId: string;
  requestedDay: string;
  note: string | null;
  rejectionReason: string | null;
  deletedAt: string | null;
  deletedByUserId: string | null;
  updatedAt: string;
};
type QuotaRow = {
  id: string;
  userId: string;
  groupId: string;
  organizationId: string;
  relatedYear: string;
  updatedAt: string;
};
type UserRow = {
  id: string;
  name: string;
  image: string | null;
  updatedAt: string;
};

/** The pull reads the history window off the server clock, in UTC. */
const THIS_YEAR = new Date().getUTCFullYear();
const LAST_YEAR = THIS_YEAR - 1;
/** `user_year_quotas` carries a range check, so no quota can be older than this. */
const FIRST_QUOTA_YEAR = 2025;

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

/**
 * One insert per table rather than a fixture call per row: the paging tests
 * need more rows than the page holds, and 1100 round trips would dominate the
 * suite's runtime.
 */
const seedMembers = async (groupId: string, count: number): Promise<string[]> => {
  const stamp = new Date();
  const members = Array.from({ length: count }, (_, index) => ({
    id: uuidv4(),
    email: `bulk-${index.toString()}-${uuidv4()}@report-e2e.test`,
    name: `Bulk ${index.toString()}`,
    emailVerified: true,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  await db.insert(user).values(members);

  const memberships = members.map((member) => ({
    id: uuidv4(),
    groupId,
    userId: member.id,
    controlledUser: true,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  await db.insert(groupUsers).values(memberships);

  return memberships.map((row) => row.id);
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

  describe("GET /api/sync/pull over more than one page", () => {
    type SyncPageBody = {
      cursor: string;
      hasMore: boolean;
      reset: boolean;
      organizations: { id: string }[];
      users: UserRow[];
      groups: GroupRow[];
      groupUsers: GroupUserRow[];
    };

    const rowCount = (page: SyncPageBody): number =>
      page.organizations.length + page.users.length + page.groups.length + page.groupUsers.length;

    const pull = async (cookie: string, cursor?: string): Promise<SyncPageBody> => {
      const call = request(app).get("/api/sync/pull").set("Cookie", cookie);
      const res = await (cursor === undefined ? call : call.query({ cursor })).expect(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      return res.body as SyncPageBody;
    };

    /** Follows the loop the way a client does: page after page until one says it is the last. */
    const pullLoop = async (cookie: string): Promise<SyncPageBody[]> => {
      const pages: SyncPageBody[] = [];
      let cursor: string | undefined;
      do {
        const page = await pull(cookie, cursor);
        pages.push(page);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor !== undefined && pages.length < 10);
      return pages;
    };

    /** A group whose membership list alone overflows one page. */
    const seedOverflowingGroup = async (): Promise<{
      cookie: string;
      groupId: string;
      membershipIds: string[];
    }> => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await seedMembers(groupId, 1100);
      await ageEverything();
      return {
        cookie: await authCookieFor(manager.id),
        groupId,
        membershipIds: await membershipIdsOf(groupId),
      };
    };

    it("splits a snapshot of more than 1000 rows into pages the caller follows to the end", async () => {
      const { cookie } = await seedOverflowingGroup();

      const pages = await pullLoop(cookie);

      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages.slice(0, -1)) {
        expect(page.hasMore).toBe(true);
        expect(rowCount(page)).toBe(1000);
      }
      const last = pages.at(-1)!;
      expect(last.hasMore).toBe(false);
      expect(rowCount(last)).toBeGreaterThan(0);
      expect(pages[0]!.organizations).toHaveLength(1);
    });

    it("keeps reset true on every page of a paged snapshot", async () => {
      const { cookie } = await seedOverflowingGroup();

      const pages = await pullLoop(cookie);

      expect(pages.every((page) => page.reset)).toBe(true);
      expect(pages.at(-1)!.organizations).toEqual([]);
      expect(pages.at(-1)!.groups).toEqual([]);
    });

    it("returns no membership twice and skips none across the pages of one loop", async () => {
      const { membershipIds, cookie } = await seedOverflowingGroup();

      const pages = await pullLoop(cookie);

      const delivered = pages.flatMap((page) => page.groupUsers.map((row) => row.id));
      expect(new Set(delivered).size).toBe(delivered.length);
      expect(delivered.sort()).toEqual([...membershipIds].sort());
    });

    it("hands back a final cursor that decodes to the time the first page was minted with", async () => {
      const { cookie } = await seedOverflowingGroup();

      const pages = await pullLoop(cookie);

      const now = new Date();
      const first = decodeSyncCursor(pages[0]!.cursor, now);
      const last = decodeSyncCursor(pages.at(-1)!.cursor, now);
      expect(first?.page?.position.table).toBe("users");
      expect(last?.page).toBeNull();
      expect(last?.cursorTime.toISOString()).toBe(first?.cursorTime.toISOString());
    });

    it("pages a delta too, keeping reset false and delivering every changed row once", async () => {
      const { membershipIds, cookie } = await seedOverflowingGroup();
      await db.update(groupUsers).set({ updatedAt: ago(5 * MINUTE) });

      // Every changed membership brings its member's user row along, so the
      // loop spans more than two pages; follow it to the end.
      const pages: SyncPageBody[] = [];
      let cursor = encodeSyncCursor(ago(10 * MINUTE));
      do {
        const page = await pull(cookie, cursor);
        pages.push(page);
        cursor = page.cursor;
      } while (pages.at(-1)!.hasMore && pages.length < 10);

      expect(pages.length).toBeGreaterThan(1);
      expect(pages.at(-1)!.hasMore).toBe(false);
      expect(pages.every((page) => page.reset === false)).toBe(true);
      const delivered = pages.flatMap((page) => page.groupUsers.map((row) => row.id));
      expect(new Set(delivered).size).toBe(delivered.length);
      expect(delivered.sort()).toEqual([...membershipIds].sort());
      const users = pages.flatMap((page) => page.users.map((row) => row.id));
      expect(new Set(users).size).toBe(users.length);
      expect(users.length).toBe(membershipIds.length);
    });

    it("leaves a row changed mid-loop to the next delta rather than chasing it into a later page", async () => {
      const { membershipIds, cookie } = await seedOverflowingGroup();

      const pages: SyncPageBody[] = [];
      let cursor: string | undefined;
      let changedLater: string | undefined;
      do {
        const page = await pull(cookie, cursor);
        pages.push(page);
        cursor = page.hasMore ? page.cursor : undefined;
        if (changedLater === undefined && page.groupUsers.length > 0) {
          const delivered = new Set(pages.flatMap((seen) => seen.groupUsers.map((row) => row.id)));
          changedLater = membershipIds.find((id) => !delivered.has(id));
          if (changedLater !== undefined) {
            await db
              .update(groupUsers)
              .set({ updatedAt: new Date() })
              .where(eq(groupUsers.id, changedLater));
          }
        }
      } while (cursor !== undefined && pages.length < 10);

      const last = pages.at(-1)!;
      const delta = await pull(cookie, last.cursor);

      expect(changedLater).toBeDefined();
      expect(last.hasMore).toBe(false);
      const delivered = pages.flatMap((page) => page.groupUsers.map((row) => row.id));
      expect(delivered).not.toContain(changedLater);
      expect(delta.reset).toBe(false);
      expect(delta.groupUsers.map((row) => row.id)).toEqual([changedLater]);
    });
  });

  describe("GET /api/sync/pull vacations", () => {
    it("returns every member's vacations in a group the caller sees in full", async () => {
      const manager = await makeUser("Manager");
      const viewer = await makeUser("Viewer");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, viewer.id, { viewAccess: true });
      await addMember(groupId, member.id);
      const own = await addLeave(groupId, viewer.id, dayIn(THIS_YEAR, 5, 4));
      const theirs = await addLeave(groupId, member.id, dayIn(THIS_YEAR, 5, 5));

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(viewer.id))
        .expect(200);

      expect((res.body.vacations as VacationRow[]).map((row) => row.id).sort()).toEqual(
        [own, theirs].sort()
      );
    });

    it("returns only the caller's own vacations in a self-scoped group", async () => {
      const manager = await makeUser("Manager");
      const plain = await makeUser("Plain");
      const other = await makeUser("Other");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, plain.id);
      await addMember(groupId, other.id);
      const own = await addLeave(groupId, plain.id, dayIn(THIS_YEAR, 5, 4));
      await addLeave(groupId, other.id, dayIn(THIS_YEAR, 5, 5));

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(plain.id))
        .expect(200);

      const rows = res.body.vacations as VacationRow[];
      expect(rows.map((row) => row.id)).toEqual([own]);
      expect(rows.every((row) => row.userId === plain.id)).toBe(true);
    });

    it("returns the caller's own vacations in a group they left, with that group and nobody else", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const other = await makeUser("Other");
      const current = await makeGroup("Engineering", manager.id);
      const left = await makeGroup("Support", manager.id);
      await addMember(current, caller.id);
      await addMember(left, caller.id);
      await addMember(left, other.id);
      const own = await addLeave(left, caller.id, dayIn(THIS_YEAR, 5, 4), {
        approvedBy: manager.id,
      });
      await addLeave(left, other.id, dayIn(THIS_YEAR, 5, 5));
      await addQuota(left, caller.id, THIS_YEAR);
      await removeMember(left, caller.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect((res.body.vacations as VacationRow[]).map((row) => row.id)).toEqual([own]);
      expect((res.body.groups as GroupRow[]).map((row) => row.id).sort()).toEqual(
        [current, left].sort()
      );
      const memberships = res.body.groupUsers as GroupUserRow[];
      expect(memberships.map((row) => row.groupId)).toEqual([current]);
      expect(res.body.userYearQuotas).toEqual([]);
      // The people named on a returned booking are the one exception to "no
      // other member of a former group appears": without the approver's row
      // the client could not render it.
      const userIds = (res.body.users as UserRow[]).map((row) => row.id);
      expect(userIds).toContain(manager.id);
      expect(userIds).not.toContain(other.id);
    });

    it("gives a manager every member's vacations and quotas without a flag of their own", async () => {
      const manager = await makeUser("Manager");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      await addMember(groupId, member.id);
      const own = await addLeave(groupId, manager.id, dayIn(THIS_YEAR, 5, 4));
      const theirs = await addLeave(groupId, member.id, dayIn(THIS_YEAR, 5, 5));
      await addQuota(groupId, manager.id, THIS_YEAR);
      await addQuota(groupId, member.id, THIS_YEAR);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect((res.body.vacations as VacationRow[]).map((row) => row.id).sort()).toEqual(
        [own, theirs].sort()
      );
      expect((res.body.userYearQuotas as QuotaRow[]).map((row) => row.userId).sort()).toEqual(
        [manager.id, member.id].sort()
      );
    });

    it("serialises a vacation row with its raw columns, note and rejection reason", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      const day = dayIn(THIS_YEAR, 5, 4);
      const vacationId = await addLeave(groupId, caller.id, day, {
        approved: false,
        rejected: true,
        rejectedBy: manager.id,
        rejectionReason: "Too many people out",
        note: "Family trip",
        createdByUserId: manager.id,
      });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      const [stored] = await db.select().from(vacation).where(eq(vacation.id, vacationId));
      expect(res.body.vacations).toEqual([
        {
          id: vacationId,
          userId: caller.id,
          groupId,
          organizationId: await organizationIdOf(manager.id),
          requestId: stored!.requestId,
          requestedDay: day,
          startTime: null,
          endTime: null,
          vacationType: "VACATION",
          halfDay: false,
          approvedAt: null,
          approvedBy: null,
          rejectedAt: stored!.rejectedAt!.toISOString(),
          rejectedBy: manager.id,
          rejectionReason: "Too many people out",
          note: "Family trip",
          createdByUserId: manager.id,
          deletedAt: null,
          deletedByUserId: null,
          createdAt: stored!.createdAt.toISOString(),
          updatedAt: stored!.updatedAt.toISOString(),
        },
      ]);
    });

    it("drops a vacation requested before 1 January of the previous year", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      const onTheBoundary = await addLeave(groupId, caller.id, dayIn(LAST_YEAR, 1, 1));
      await addLeave(groupId, caller.id, dayIn(LAST_YEAR - 1, 12, 31));

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect((res.body.vacations as VacationRow[]).map((row) => row.id)).toEqual([onTheBoundary]);
    });
  });

  describe("GET /api/sync/pull year quotas", () => {
    it("returns every member's quotas in a group the caller sees in full", async () => {
      const manager = await makeUser("Manager");
      const viewer = await makeUser("Viewer");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, viewer.id, { viewAccess: true });
      await addMember(groupId, member.id);
      await addQuota(groupId, viewer.id, THIS_YEAR);
      await addQuota(groupId, member.id, THIS_YEAR);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(viewer.id))
        .expect(200);

      const rows = res.body.userYearQuotas as QuotaRow[];
      expect(rows.map((row) => row.userId).sort()).toEqual([viewer.id, member.id].sort());
      for (const row of rows) expect(row.organizationId).toBe(await organizationIdOf(manager.id));
    });

    it("returns only the caller's own quotas in a self-scoped group", async () => {
      const manager = await makeUser("Manager");
      const plain = await makeUser("Plain");
      const other = await makeUser("Other");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, plain.id);
      await addMember(groupId, other.id);
      await addQuota(groupId, plain.id, THIS_YEAR);
      await addQuota(groupId, other.id, THIS_YEAR);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(plain.id))
        .expect(200);

      const rows = res.body.userYearQuotas as QuotaRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(plain.id);
    });

    it("keeps a quota for the previous year", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      await addQuota(groupId, caller.id, LAST_YEAR);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect((res.body.userYearQuotas as QuotaRow[]).map((row) => row.relatedYear)).toEqual([
        LAST_YEAR.toString(),
      ]);
    });

    // The schema's range check forbids a related year below 2025, so the
    // dropped side of the boundary is only expressible once the window has
    // moved past it.
    it.skipIf(LAST_YEAR - 1 < FIRST_QUOTA_YEAR)(
      "drops a quota for the year before the history window",
      async () => {
        const manager = await makeUser("Manager");
        const caller = await makeUser("Caller");
        const groupId = await makeGroup("Engineering", manager.id);
        await addMember(groupId, caller.id);
        await addQuota(groupId, caller.id, LAST_YEAR);
        await addQuota(groupId, caller.id, LAST_YEAR - 1);

        const res = await request(app)
          .get("/api/sync/pull")
          .set("Cookie", await authCookieFor(caller.id))
          .expect(200);

        expect((res.body.userYearQuotas as QuotaRow[]).map((row) => row.relatedYear)).toEqual([
          LAST_YEAR.toString(),
        ]);
      }
    );
  });

  describe("GET /api/sync/pull users", () => {
    it("returns the members and managers of a group seen in full, and the caller", async () => {
      const manager = await makeUser("Manager");
      const viewer = await makeUser("Viewer");
      const member = await makeUser("Member");
      const stranger = await makeUser("Stranger");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, viewer.id, { viewAccess: true });
      await addMember(groupId, member.id);
      await makeGroup("Finance", stranger.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(viewer.id))
        .expect(200);

      const ids = (res.body.users as UserRow[]).map((row) => row.id).sort();
      expect(ids).toEqual([manager.id, viewer.id, member.id].sort());
      expect(ids).not.toContain(stranger.id);
    });

    it("carries exactly id, name, image and updatedAt on a users row", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      const [stored] = await db.select().from(user).where(eq(user.id, manager.id));

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(manager.id))
        .expect(200);

      expect(res.body.users).toEqual([
        {
          id: manager.id,
          name: "Manager",
          image: null,
          updatedAt: stored!.updatedAt.toISOString(),
        },
      ]);
    });

    it("returns a users row for every actor on a returned vacation", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const approver = await makeUser("Approver");
      const booker = await makeUser("Booker");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      await addLeave(groupId, caller.id, dayIn(THIS_YEAR, 5, 4), {
        approvedBy: approver.id,
        createdByUserId: booker.id,
      });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      const ids = (res.body.users as UserRow[]).map((row) => row.id);
      expect(ids).toContain(approver.id);
      expect(ids).toContain(booker.id);
      expect(ids).toContain(caller.id);
    });
  });

  describe("GET /api/sync/pull deltas over the new tables", () => {
    it("carries the user row of a member added to a full group since the cursor", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const newcomer = await makeUser("Newcomer");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id, { viewAccess: true });
      await ageEverything();
      await addMember(groupId, newcomer.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect(res.body.reset).toBe(false);
      expect((res.body.groupUsers as GroupUserRow[]).map((row) => row.userId)).toEqual([
        newcomer.id,
      ]);
      expect((res.body.users as UserRow[]).map((row) => row.id)).toEqual([newcomer.id]);
    });

    it("carries a vacation changed since the cursor and leaves an untouched one out", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      const changed = await addLeave(groupId, caller.id, dayIn(THIS_YEAR, 5, 4));
      await addLeave(groupId, caller.id, dayIn(THIS_YEAR, 5, 5));
      await ageEverything();
      await db
        .update(vacation)
        .set({ updatedAt: ago(1 * MINUTE) })
        .where(eq(vacation.id, changed));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect(res.body.reset).toBe(false);
      expect((res.body.vacations as VacationRow[]).map((row) => row.id)).toEqual([changed]);
    });

    it("carries an actor whose own row changed even though their booking did not", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const approver = await makeUser("Approver");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      await addLeave(groupId, caller.id, dayIn(THIS_YEAR, 5, 4), { approvedBy: approver.id });
      await ageEverything();
      await db
        .update(user)
        .set({ name: "Approver Renamed", updatedAt: ago(1 * MINUTE) })
        .where(eq(user.id, approver.id));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect(res.body.reset).toBe(false);
      expect(res.body.vacations).toEqual([]);
      expect(res.body.users).toEqual([
        expect.objectContaining({ id: approver.id, name: "Approver Renamed" }),
      ]);
    });

    it("carries a quota changed since the cursor and leaves an untouched one out", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      await addQuota(groupId, caller.id, THIS_YEAR);
      await addQuota(groupId, caller.id, LAST_YEAR);
      await ageEverything();
      await db
        .update(userYearQuotas)
        .set({ updatedAt: ago(1 * MINUTE) })
        .where(eq(userYearQuotas.relatedYear, THIS_YEAR.toString()));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect((res.body.userYearQuotas as QuotaRow[]).map((row) => row.relatedYear)).toEqual([
        THIS_YEAR.toString(),
      ]);
    });

    it("returns a cancelled vacation in full with deletedAt set on the next delta", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      const day = dayIn(THIS_YEAR, 5, 4);
      const vacationId = await addLeave(groupId, caller.id, day, { note: "Family trip" });
      await ageEverything();
      const cancelledAt = ago(1 * MINUTE);
      await cancelLeave(vacationId, manager.id, cancelledAt);

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect(res.body.reset).toBe(false);
      const rows = res.body.vacations as VacationRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(vacationId);
      expect(rows[0]!.deletedAt).toBe(cancelledAt.toISOString());
      expect(rows[0]!.requestedDay).toBe(day);
      expect(rows[0]!.note).toBe("Family trip");
      expect(rows[0]!.deletedByUserId).toBe(manager.id);
      // The users table was aged out of the delta's window, so the manager can
      // only be here as the actor who cancelled the booking.
      expect((res.body.users as UserRow[]).map((row) => row.id)).toContain(manager.id);
    });

    it("keeps a cancelled vacation in a snapshot, as the web calendar does", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      const vacationId = await addLeave(groupId, caller.id, dayIn(THIS_YEAR, 5, 4));
      await cancelLeave(vacationId, manager.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect(res.body.reset).toBe(true);
      expect((res.body.vacations as VacationRow[]).map((row) => row.id)).toEqual([vacationId]);
    });
  });
});
