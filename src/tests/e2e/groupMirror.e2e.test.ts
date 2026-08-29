import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { groupMirrors } from "../../db/schema/group-mirror-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { vacation, CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { v4 as uuidv4 } from "uuid";
import { getVacationsForGroup } from "../../services/vacation/vacationServices.js";
import {
  getMirrorsIntoGroupForUser,
  setMirrorsIntoGroupForUser,
} from "../../services/groupMirror/groupMirrorServices.js";
import { getPendingApprovalsForApprover } from "../../services/vacation/vacationServices.js";
import { createTestGroup, createTestUser, cleanupTestData } from "./helpers/testSetup.js";

/**
 * Mirroring lives almost entirely in one SQL query, so it is verified here
 * against a real database rather than with mocks.
 *
 * Shape under test: Dana books her time off in "Team A" (where her manager
 * approves it) and wants it visible in "All Engineering", the umbrella group
 * she also belongs to.
 */
describe("group mirroring", () => {
  let dana: { id: string };
  let outsider: { id: string };
  let manager: { id: string };
  let teamA: { id: string };
  let allEng: { id: string };

  const MONTH_START = "2026-03-01";
  const MONTH_END = "2026-04-01";

  const addMember = (userId: string, groupId: string) =>
    db.insert(groupUsers).values({
      id: uuidv4(),
      userId,
      groupId,
      viewAccess: true,
      adminAccess: false,
      controlledUser: true,
    });

  const removeMember = (userId: string, groupId: string) =>
    db
      .delete(groupUsers)
      .where(and(eq(groupUsers.userId, userId), eq(groupUsers.groupId, groupId)));

  const setMirrors = (sourceGroupIds: string[], manageable: string[] = [teamA.id]) =>
    setMirrorsIntoGroupForUser(dana.id, allEng.id, sourceGroupIds, manageable);

  const book = (userId: string, groupId: string, day: string, approved = true) =>
    db.insert(vacation).values({
      id: uuidv4(),
      userId,
      groupId,
      requestedDay: day,
      vacationType: CalendarRecordType.Vacation,
      approvedAt: approved ? new Date() : null,
      approvedBy: approved ? manager.id : null,
    });

  beforeAll(async () => {
    await cleanupTestData();

    manager = await createTestUser("mirror-manager@test.com", "Manager", "password123");
    dana = await createTestUser("mirror-dana@test.com", "Dana Holt", "password123");
    outsider = await createTestUser("mirror-outsider@test.com", "Outsider", "password123");

    teamA = await createTestGroup("Team A", manager.id, manager.id);
    allEng = await createTestGroup("All Engineering", manager.id, manager.id);

    await addMember(dana.id, teamA.id);
    await addMember(dana.id, allEng.id);
    await addMember(outsider.id, teamA.id);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(groupMirrors);
    await db.delete(vacation);
  });

  it("hides records booked elsewhere until a mirror exists", async () => {
    await book(dana.id, teamA.id, "2026-03-10");

    const rows = await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(0);
  });

  it("shows a mirrored record in the target group, flagged with its source", async () => {
    await book(dana.id, teamA.id, "2026-03-10");
    await setMirrors([teamA.id]);

    const rows = await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: dana.id,
      groupId: teamA.id,
      requestedDay: "2026-03-10",
      mirroredFromGroupId: teamA.id,
      mirroredFromGroupName: "Team A",
    });
  });

  it("leaves the group's own records unflagged", async () => {
    await book(dana.id, allEng.id, "2026-03-11");

    const rows = await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.mirroredFromGroupId).toBeNull();
    expect(rows[0]?.mirroredFromGroupName).toBeNull();
  });

  it("returns own and mirrored records together, without duplicating either", async () => {
    await addMember(outsider.id, allEng.id);
    await book(dana.id, teamA.id, "2026-03-10");
    await book(outsider.id, allEng.id, "2026-03-12");
    await setMirrors([teamA.id]);

    const rows = await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.requestedDay)).toEqual(["2026-03-10", "2026-03-12"]);

    await removeMember(outsider.id, allEng.id);
  });

  it("stops projecting a member's records once they leave the target group", async () => {
    await book(dana.id, teamA.id, "2026-03-10");
    await setMirrors([teamA.id]);
    expect(await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END)).toHaveLength(1);

    // The mirror row survives, but someone who left must not keep leaking time
    // off into a group they no longer belong to.
    await removeMember(dana.id, allEng.id);

    expect(await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END)).toHaveLength(0);

    await addMember(dana.id, allEng.id);
  });

  it("does not mirror in the opposite direction", async () => {
    await book(dana.id, allEng.id, "2026-03-13");
    await setMirrors([teamA.id]);

    const rows = await getVacationsForGroup(teamA.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(0);
  });

  it("never makes a mirrored record approvable in the target group", async () => {
    await book(dana.id, teamA.id, "2026-03-14", false);
    await setMirrors([teamA.id]);

    const pending = await getPendingApprovalsForApprover(manager.id);

    // Visible in All Engineering, but the only decision to make is in Team A.
    expect(pending).toHaveLength(1);
    expect(pending[0]?.groupId).toBe(teamA.id);
  });

  it("mirrors pending records too, so the team sees planned absence", async () => {
    await book(dana.id, teamA.id, "2026-03-15", false);
    await setMirrors([teamA.id]);

    const rows = await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.approvedAt).toBeNull();
  });

  it("stops mirroring when the source is removed", async () => {
    await book(dana.id, teamA.id, "2026-03-10");
    await setMirrors([teamA.id]);
    await setMirrors([]);

    const rows = await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(0);
    expect(await getMirrorsIntoGroupForUser(dana.id, allEng.id)).toHaveLength(0);
  });

  it("only mirrors the user who opted in, not everyone in the source group", async () => {
    await book(dana.id, teamA.id, "2026-03-10");
    await book(outsider.id, teamA.id, "2026-03-16");
    await setMirrors([teamA.id]);

    const rows = await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(dana.id);
  });

  it("keeps the date-range filter", async () => {
    await book(dana.id, teamA.id, "2026-02-20");
    await book(dana.id, teamA.id, "2026-03-10");
    await setMirrors([teamA.id]);

    const rows = await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestedDay).toBe("2026-03-10");
  });

  it("honours the per-user filter", async () => {
    await book(dana.id, teamA.id, "2026-03-10");
    await setMirrors([teamA.id]);

    expect(await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END, dana.id)).toHaveLength(1);
    expect(await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END, outsider.id)).toHaveLength(
      0
    );
  });

  it("is idempotent and does not duplicate rows when set twice", async () => {
    await book(dana.id, teamA.id, "2026-03-10");
    await setMirrors([teamA.id]);
    await setMirrors([teamA.id]);

    expect(await getMirrorsIntoGroupForUser(dana.id, allEng.id)).toHaveLength(1);
    expect(await getVacationsForGroup(allEng.id, MONTH_START, MONTH_END)).toHaveLength(1);
  });

  it("names the source group for the settings screen", async () => {
    await setMirrors([teamA.id]);

    const mirrors = await getMirrorsIntoGroupForUser(dana.id, allEng.id);

    expect(mirrors[0]).toMatchObject({ sourceGroupId: teamA.id, sourceGroupName: "Team A" });
  });

  it("leaves a mirror outside the caller's reach alone when saving", async () => {
    await setMirrors([teamA.id]);

    // Team A is not this admin's to remove, so it must survive the save.
    await setMirrors([], []);

    expect(await getMirrorsIntoGroupForUser(dana.id, allEng.id)).toHaveLength(1);
  });
});
