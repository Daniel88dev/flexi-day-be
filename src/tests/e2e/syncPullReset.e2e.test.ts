import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { encodeSyncCursor } from "../../services/sync/syncCursor.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addMirror,
  addQuota,
  ageEverything,
  dayIn,
  makeGroup,
  makeUser,
  removeMember,
  removeMirror,
  resetReportData,
  seedMembers,
} from "./helpers/reportFixtures.js";

type IdRow = { id: string };
type GroupRow = { id: string; groupName: string; holidayCountry: string | null };
type GroupUserRow = { id: string; userId: string; viewAccess: boolean };
type BankHolidayRow = { id: string; country: string };

type SyncBody = {
  cursor: string;
  hasMore: boolean;
  reset: boolean;
  organizations: IdRow[];
  users: IdRow[];
  groups: GroupRow[];
  groupUsers: GroupUserRow[];
  groupMirrors: IdRow[];
  userYearQuotas: IdRow[];
  bankHolidays: BankHolidayRow[];
  vacations: IdRow[];
};

const THIS_YEAR = new Date().getUTCFullYear();

const MINUTE = 60 * 1000;
const ago = (ms: number): Date => new Date(Date.now() - ms);

/** The cursor every case here sends: old enough that only a fresh change lands in the window. */
const staleCursor = (): string => encodeSyncCursor(ago(10 * MINUTE));

const organizationIdOf = async (userId: string): Promise<string> =>
  (await ensureOrganizationForUser(userId)).id;

const idsOf = (rows: IdRow[]): string[] => rows.map((row) => row.id);

describe("Sync pull reset triggers E2E", () => {
  let app: Express;

  const pull = async (cookie: string, cursor?: string): Promise<SyncBody> => {
    const call = request(app).get("/api/sync/pull").set("Cookie", cookie);
    const res = await (cursor === undefined ? call : call.query({ cursor })).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    return res.body as SyncBody;
  };

  beforeAll(() => {
    app = createServer();
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await resetReportData();
  });

  describe("a membership row of the caller", () => {
    it("answers a sync reset after the caller's own membership is removed", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id, { viewAccess: true });
      await ageEverything();
      await removeMember(groupId, caller.id);

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      // The snapshot carries nothing of the group, which is how the client
      // knows to sweep the rows it still holds for it.
      expect(body.reset).toBe(true);
      expect(body.groups).toEqual([]);
      expect(body.groupUsers).toEqual([]);
      expect(body.organizations).toEqual([]);
    });

    it("answers a sync reset when the caller joins a group older than the cursor", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id, { adminAccess: true });
      await ageEverything();
      await addMember(groupId, caller.id);

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      // The group row itself never changed, so only a snapshot can deliver it.
      expect(body.reset).toBe(true);
      expect(idsOf(body.groups)).toEqual([groupId]);
      expect(idsOf(body.organizations)).toEqual([await organizationIdOf(manager.id)]);
      expect(body.groupUsers.map((row) => row.userId)).toEqual([caller.id]);
    });

    it("answers a sync reset when a flag changes on the caller's membership", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      await addMember(groupId, member.id);
      await ageEverything();
      await db
        .update(groupUsers)
        .set({ viewAccess: true, updatedAt: new Date() })
        .where(and(eq(groupUsers.groupId, groupId), eq(groupUsers.userId, caller.id)));

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      expect(body.reset).toBe(true);
      expect(body.groupUsers.map((row) => row.userId).sort()).toEqual(
        [caller.id, member.id].sort()
      );
    });
  });

  describe("a mirror row targeting a scoped group", () => {
    /** Dana books in her own team and the caller sees the umbrella group in full. */
    const seedMirrorShape = async () => {
      const sourceManager = await makeUser("Source Manager");
      const targetManager = await makeUser("Target Manager");
      const caller = await makeUser("Caller");
      const dana = await makeUser("Dana");
      const sourceGroupId = await makeGroup("Team A", sourceManager.id);
      const targetGroupId = await makeGroup("All Engineering", targetManager.id);
      await addMember(sourceGroupId, dana.id);
      await addMember(targetGroupId, dana.id);
      await addMember(targetGroupId, caller.id, { viewAccess: true });
      const mirroredVacationId = await addLeave(sourceGroupId, dana.id, dayIn(THIS_YEAR, 5, 4));

      return {
        caller,
        dana,
        sourceManager,
        sourceGroupId,
        targetGroupId,
        mirroredVacationId,
      };
    };

    it("answers a sync reset when a mirror into a group seen in full is added", async () => {
      const fixture = await seedMirrorShape();
      await ageEverything();
      const mirrorId = await addMirror(
        fixture.dana.id,
        fixture.sourceGroupId,
        fixture.targetGroupId
      );

      const body = await pull(await authCookieFor(fixture.caller.id), staleCursor());

      expect(body.reset).toBe(true);
      expect(idsOf(body.groupMirrors)).toEqual([mirrorId]);
      // The mirrored history and everything that labels it arrive with it,
      // none of which a delta would have carried: only the mirror changed.
      expect(idsOf(body.vacations)).toContain(fixture.mirroredVacationId);
      expect(idsOf(body.groups).sort()).toEqual(
        [fixture.sourceGroupId, fixture.targetGroupId].sort()
      );
      expect(idsOf(body.organizations)).toContain(await organizationIdOf(fixture.sourceManager.id));
      expect(idsOf(body.users)).toContain(fixture.dana.id);
    });

    it("answers a sync reset when a mirror into a group seen in full is removed", async () => {
      const fixture = await seedMirrorShape();
      const mirrorId = await addMirror(
        fixture.dana.id,
        fixture.sourceGroupId,
        fixture.targetGroupId
      );
      await ageEverything();
      await removeMirror(mirrorId);

      const body = await pull(await authCookieFor(fixture.caller.id), staleCursor());

      expect(body.reset).toBe(true);
      expect(body.groupMirrors).toEqual([]);
      expect(idsOf(body.vacations)).not.toContain(fixture.mirroredVacationId);
      expect(idsOf(body.groups)).toEqual([fixture.targetGroupId]);
    });

    it("answers a sync reset when the mirror's owner leaves the target group", async () => {
      const fixture = await seedMirrorShape();
      await addMirror(fixture.dana.id, fixture.sourceGroupId, fixture.targetGroupId);
      await ageEverything();
      await removeMember(fixture.targetGroupId, fixture.dana.id);

      const body = await pull(await authCookieFor(fixture.caller.id), staleCursor());

      expect(body.reset).toBe(true);
      expect(body.groupMirrors).toEqual([]);
      expect(idsOf(body.vacations)).not.toContain(fixture.mirroredVacationId);
    });

    it("answers a sync reset when the mirror's owner rejoins the target group", async () => {
      const fixture = await seedMirrorShape();
      const mirrorId = await addMirror(
        fixture.dana.id,
        fixture.sourceGroupId,
        fixture.targetGroupId
      );
      await removeMember(fixture.targetGroupId, fixture.dana.id);
      await ageEverything();
      await addMember(fixture.targetGroupId, fixture.dana.id);

      const body = await pull(await authCookieFor(fixture.caller.id), staleCursor());

      expect(body.reset).toBe(true);
      expect(idsOf(body.groupMirrors)).toEqual([mirrorId]);
      expect(idsOf(body.vacations)).toContain(fixture.mirroredVacationId);
    });
  });

  describe("a scoped group row", () => {
    it("answers a sync reset when the group's manager changes", async () => {
      const manager = await makeUser("Manager");
      const successor = await makeUser("Successor");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id, { viewAccess: true });
      await addMember(groupId, successor.id);
      await ageEverything();
      await db
        .update(groups)
        .set({ managerUserId: successor.id, updatedAt: new Date() })
        .where(eq(groups.id, groupId));

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      expect(body.reset).toBe(true);
      expect(idsOf(body.groups)).toEqual([groupId]);
    });

    it("answers a sync reset when the group is renamed", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id);
      await ageEverything();
      await db
        .update(groups)
        .set({ groupName: "Platform", updatedAt: new Date() })
        .where(eq(groups.id, groupId));

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      expect(body.reset).toBe(true);
      expect(body.groups.map((row) => row.groupName)).toEqual(["Platform"]);
    });

    it("answers a sync reset carrying the new country's holidays when the group's changes", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id, { holidayCountry: "CZ" });
      await addMember(groupId, caller.id);
      await ageEverything();
      await db
        .update(groups)
        .set({ holidayCountry: "SK", updatedAt: new Date() })
        .where(eq(groups.id, groupId));

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      expect(body.reset).toBe(true);
      expect(body.groups.map((row) => row.holidayCountry)).toEqual(["SK"]);
      expect(body.bankHolidays.length).toBeGreaterThan(0);
      expect([...new Set(body.bankHolidays.map((row) => row.country))]).toEqual(["SK"]);
    });

    it("answers a sync reset that drops a group soft-deleted since the cursor", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id, { viewAccess: true });
      await ageEverything();
      const deletedAt = new Date();
      await db
        .update(groups)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(eq(groups.id, groupId));

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      // A snapshot holds live rows only, so the deleted group leaves the
      // client's copy on the sweep rather than on a tombstone.
      expect(body.reset).toBe(true);
      expect(body.groups).toEqual([]);
      expect(body.groupUsers).toEqual([]);
    });
  });

  describe("a change that is not a trigger", () => {
    it("answers a delta for another member's vacation", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id, { viewAccess: true });
      await addMember(groupId, member.id);
      const vacationId = await addLeave(groupId, member.id, dayIn(THIS_YEAR, 5, 4));
      await ageEverything();
      await db.update(vacation).set({ updatedAt: new Date() }).where(eq(vacation.id, vacationId));

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      expect(body.reset).toBe(false);
      expect(idsOf(body.vacations)).toEqual([vacationId]);
      expect(body.groups).toEqual([]);
      expect(body.groupUsers).toEqual([]);
    });

    it("answers a delta for a quota edit", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const member = await makeUser("Member");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, caller.id, { viewAccess: true });
      await addMember(groupId, member.id);
      await ageEverything();
      await addQuota(groupId, member.id, THIS_YEAR, { vacationDays: 25 });

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      expect(body.reset).toBe(false);
      expect(body.userYearQuotas).toHaveLength(1);
      expect(body.groups).toEqual([]);
    });

    it("answers a delta for a membership change in a group the caller is not in", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const outsider = await makeUser("Outsider");
      const groupId = await makeGroup("Engineering", manager.id);
      const foreignGroupId = await makeGroup("Finance", manager.id);
      await addMember(groupId, caller.id, { viewAccess: true });
      await ageEverything();
      await addMember(foreignGroupId, outsider.id);

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      expect(body.reset).toBe(false);
      expect(body.groupUsers).toEqual([]);
      expect(body.groups).toEqual([]);
    });

    it("answers a delta for a mirror into a group the caller is not in", async () => {
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const dana = await makeUser("Dana");
      const groupId = await makeGroup("Engineering", manager.id);
      const sourceGroupId = await makeGroup("Team A", manager.id);
      const foreignTargetId = await makeGroup("Finance", manager.id);
      await addMember(groupId, caller.id, { viewAccess: true });
      await addMember(sourceGroupId, dana.id);
      await addMember(foreignTargetId, dana.id);
      await ageEverything();
      await addMirror(dana.id, sourceGroupId, foreignTargetId);

      const body = await pull(await authCookieFor(caller.id), staleCursor());

      expect(body.reset).toBe(false);
      expect(body.groupMirrors).toEqual([]);
      expect(body.groups).toEqual([]);
    });
  });

  describe("a triggered reset over more than one page", () => {
    it("pages the snapshot the way a pull without a cursor does", async () => {
      const manager = await makeUser("Manager");
      const groupId = await makeGroup("Engineering", manager.id);
      await addMember(groupId, manager.id);
      const bulkMembershipIds = await seedMembers(groupId, 1100);
      await ageEverything();
      await db
        .update(groupUsers)
        .set({ adminAccess: true, updatedAt: new Date() })
        .where(and(eq(groupUsers.groupId, groupId), eq(groupUsers.userId, manager.id)));
      const cookie = await authCookieFor(manager.id);

      const pages: SyncBody[] = [];
      let cursor: string | undefined = staleCursor();
      do {
        const page: SyncBody = await pull(cookie, cursor);
        pages.push(page);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor !== undefined && pages.length < 10);

      expect(pages.length).toBeGreaterThan(1);
      expect(pages.every((page) => page.reset)).toBe(true);
      expect(pages.at(-1)!.hasMore).toBe(false);
      for (const page of pages.slice(0, -1)) {
        const rows =
          page.organizations.length +
          page.users.length +
          page.groups.length +
          page.groupUsers.length;
        expect(rows).toBe(1000);
      }
      const delivered = pages.flatMap((page) => page.groupUsers.map((row) => row.id));
      expect(new Set(delivered).size).toBe(delivered.length);
      expect(delivered).toHaveLength(bulkMembershipIds.length + 1);
    });
  });
});
