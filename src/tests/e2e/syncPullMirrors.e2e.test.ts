import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { encodeSyncCursor } from "../../services/sync/syncCursor.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addMirror,
  ageEverything,
  dayIn,
  makeGroup,
  makeUser,
  removeMember,
  removeMirror,
  resetReportData,
} from "./helpers/reportFixtures.js";

type MirrorRow = {
  id: string;
  userId: string;
  sourceGroupId: string;
  targetGroupId: string;
  organizationId: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type VacationRow = { id: string; userId: string; groupId: string; organizationId: string };
type GroupRow = { id: string; organizationId: string };
type UserRow = { id: string };

const THIS_YEAR = new Date().getUTCFullYear();

const MINUTE = 60 * 1000;
const ago = (ms: number): Date => new Date(Date.now() - ms);

const organizationIdOf = async (userId: string): Promise<string> =>
  (await ensureOrganizationForUser(userId)).id;

/**
 * The shape every case here builds on: Dana books her time off in her own
 * team and mirrors it into the umbrella group, where the caller can see the
 * whole group.
 */
type MirrorFixture = {
  caller: { id: string };
  dana: { id: string };
  manager: { id: string };
  sourceGroupId: string;
  targetGroupId: string;
  mirrorId: string;
  mirroredVacationId: string;
};

const seedMirror = async (
  options: { targetAccess?: "all" | "self" } = {}
): Promise<MirrorFixture> => {
  const manager = await makeUser("Manager");
  const caller = await makeUser("Caller");
  const dana = await makeUser("Dana");
  const sourceGroupId = await makeGroup("Team A", manager.id);
  const targetGroupId = await makeGroup("All Engineering", manager.id);

  await addMember(sourceGroupId, dana.id);
  await addMember(targetGroupId, dana.id);
  await addMember(targetGroupId, caller.id, {
    viewAccess: (options.targetAccess ?? "all") === "all",
  });

  const mirroredVacationId = await addLeave(sourceGroupId, dana.id, dayIn(THIS_YEAR, 5, 4), {
    approvedBy: manager.id,
  });
  const mirrorId = await addMirror(dana.id, sourceGroupId, targetGroupId);

  return { caller, dana, manager, sourceGroupId, targetGroupId, mirrorId, mirroredVacationId };
};

describe("Sync pull mirrors E2E", () => {
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

  describe("GET /api/sync/pull group mirrors", () => {
    it("returns the mirror row and the mirrored member's vacations in a group seen in full", async () => {
      const fixture = await seedMirror();
      const outsider = await makeUser("Outsider");
      await addMember(fixture.sourceGroupId, outsider.id);
      const unmirrored = await addLeave(fixture.sourceGroupId, outsider.id, dayIn(THIS_YEAR, 5, 5));

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(fixture.caller.id))
        .expect(200);

      expect((res.body.groupMirrors as MirrorRow[]).map((row) => row.id)).toEqual([
        fixture.mirrorId,
      ]);
      const vacationIds = (res.body.vacations as VacationRow[]).map((row) => row.id);
      expect(vacationIds).toContain(fixture.mirroredVacationId);
      // Nothing else of the source group comes with it: only what the mirror projects.
      expect(vacationIds).not.toContain(unmirrored);
    });

    it("returns neither the mirror nor the mirrored vacations when the target is self-scoped", async () => {
      const fixture = await seedMirror({ targetAccess: "self" });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(fixture.caller.id))
        .expect(200);

      expect(res.body.groupMirrors).toEqual([]);
      expect((res.body.vacations as VacationRow[]).map((row) => row.id)).not.toContain(
        fixture.mirroredVacationId
      );
      expect((res.body.groups as GroupRow[]).map((row) => row.id)).toEqual([fixture.targetGroupId]);
    });

    it("brings nothing from a mirror whose owner no longer belongs to the target group", async () => {
      const fixture = await seedMirror();
      await removeMember(fixture.targetGroupId, fixture.dana.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(fixture.caller.id))
        .expect(200);

      expect(res.body.groupMirrors).toEqual([]);
      expect((res.body.vacations as VacationRow[]).map((row) => row.id)).not.toContain(
        fixture.mirroredVacationId
      );
      expect((res.body.groups as GroupRow[]).map((row) => row.id)).toEqual([fixture.targetGroupId]);
    });

    it("names the source group and everyone on a mirrored booking so the client can label the rows", async () => {
      const fixture = await seedMirror();
      const sourceApprover = await makeUser("Source Approver");
      await addMember(fixture.sourceGroupId, sourceApprover.id, { approverAccess: true });
      await addLeave(fixture.sourceGroupId, fixture.dana.id, dayIn(THIS_YEAR, 5, 6), {
        approvedBy: sourceApprover.id,
      });

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(fixture.caller.id))
        .expect(200);

      expect((res.body.groups as GroupRow[]).map((row) => row.id).sort()).toEqual(
        [fixture.sourceGroupId, fixture.targetGroupId].sort()
      );
      const userIds = (res.body.users as UserRow[]).map((row) => row.id);
      expect(userIds).toContain(fixture.dana.id);
      // Whoever approved a mirrored booking belongs to the source group alone,
      // and the caller still cannot render the row without their name.
      expect(userIds).toContain(sourceApprover.id);
    });

    it("carries the target group's organization on the mirror row and on the mirrored booking", async () => {
      const otherManager = await makeUser("Other Manager");
      const manager = await makeUser("Manager");
      const caller = await makeUser("Caller");
      const dana = await makeUser("Dana");
      const sourceGroupId = await makeGroup("Team A", otherManager.id);
      const targetGroupId = await makeGroup("All Engineering", manager.id);
      await addMember(sourceGroupId, dana.id);
      await addMember(targetGroupId, dana.id);
      await addMember(targetGroupId, caller.id, { viewAccess: true });
      const mirroredVacationId = await addLeave(sourceGroupId, dana.id, dayIn(THIS_YEAR, 5, 4));
      const mirrorId = await addMirror(dana.id, sourceGroupId, targetGroupId);
      const [stored] = await db.select().from(groupMirrors).where(eq(groupMirrors.id, mirrorId));
      const sourceOrganizationId = await organizationIdOf(otherManager.id);
      const targetOrganizationId = await organizationIdOf(manager.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .expect(200);

      expect(res.body.groupMirrors).toEqual([
        {
          id: mirrorId,
          userId: dana.id,
          sourceGroupId,
          targetGroupId,
          organizationId: targetOrganizationId,
          deletedAt: null,
          createdAt: stored!.createdAt.toISOString(),
          updatedAt: stored!.updatedAt.toISOString(),
        },
      ]);
      // A mirrored booking stays a row of its own group, so it carries that
      // group's organization rather than the target's.
      const mirrored = (res.body.vacations as VacationRow[]).find(
        (row) => row.id === mirroredVacationId
      );
      expect(mirrored!.organizationId).toBe(sourceOrganizationId);
      expect((res.body.organizations as { id: string }[]).map((row) => row.id).sort()).toEqual(
        [sourceOrganizationId, targetOrganizationId].sort()
      );
    });

    // A mirror into a group the caller sees in full is a reset trigger, so a
    // removed one never reaches them as a delta tombstone: the snapshot simply
    // stops carrying it, and the client sweeps what the snapshot left out.
    it("drops a removed mirror and the bookings it projected from the reset that follows", async () => {
      const fixture = await seedMirror();
      await ageEverything();
      await removeMirror(fixture.mirrorId, ago(1 * MINUTE));

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(fixture.caller.id))
        .expect(200);

      expect(res.body.reset).toBe(true);
      expect(res.body.groupMirrors).toEqual([]);
      expect((res.body.vacations as VacationRow[]).map((row) => row.id)).not.toContain(
        fixture.mirroredVacationId
      );
      expect((res.body.groups as GroupRow[]).map((row) => row.id)).toEqual([fixture.targetGroupId]);
    });

    it("carries a mirror added since the cursor in the reset that follows", async () => {
      const fixture = await seedMirror();
      const secondSource = await makeGroup("Team B", fixture.manager.id);
      await addMember(secondSource, fixture.dana.id);
      await ageEverything();
      const addedMirror = await addMirror(fixture.dana.id, secondSource, fixture.targetGroupId);

      const res = await request(app)
        .get("/api/sync/pull")
        .query({ cursor: encodeSyncCursor(ago(10 * MINUTE)) })
        .set("Cookie", await authCookieFor(fixture.caller.id))
        .expect(200);

      expect(res.body.reset).toBe(true);
      // The snapshot carries the untouched mirror too: it is the whole of what
      // the caller may see, not what changed.
      expect((res.body.groupMirrors as MirrorRow[]).map((row) => row.id).sort()).toEqual(
        [fixture.mirrorId, addedMirror].sort()
      );
    });
  });
});
