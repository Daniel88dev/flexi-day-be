import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { CalendarRecordType, vacation } from "../../db/schema/vacation-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { encodeSyncCursor } from "../../services/sync/syncCursor.js";
import { SYNC_PAGE_SIZE } from "../../services/sync/syncPage.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addMirror,
  ageEverything,
  cancelLeave,
  dayIn,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

/** The capability the phone sends on the pull once it can store `AWAY`. */
const ACCEPTS_HEADER = "x-client-sync-accepts";

const YEAR = new Date().getUTCFullYear() + 1;
const day = (d: number) => dayIn(YEAR, 3, d);

const MINUTE = 60 * 1000;
const ago = (ms: number): Date => new Date(Date.now() - ms);

type VacationRow = {
  id: string;
  userId: string;
  vacationType: string;
  startTime: string | null;
  endTime: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  note: string | null;
  createdByUserId: string | null;
  deletedAt: string | null;
  deletedByUserId: string | null;
};

/**
 * Team is managed by Mia, who holds no membership row. Tom is a plain member,
 * Vera holds View, Ann holds View and approves Team. Dave belongs to Team and
 * mirrors his own group Source into it; Ann has no standing in Source.
 */
const seed = async () => {
  const mia = await makeUser("Mia Manager");
  const tom = await makeUser("Tom Teammate");
  const vera = await makeUser("Vera Viewer");
  const ann = await makeUser("Ann Approver");
  const dave = await makeUser("Dave Mirror");

  const team = await makeGroup("Team", mia.id);
  await addMember(team, tom.id);
  await addMember(team, vera.id, { viewAccess: true });
  await addMember(team, ann.id, { viewAccess: true, approverAccess: true });
  await addMember(team, dave.id);
  const source = await makeGroup("Source", dave.id);
  await addMember(source, dave.id, { viewAccess: true, adminAccess: true });
  await addMirror(dave.id, source, team);

  const tomSick = await addLeave(team, tom.id, day(2), {
    type: CalendarRecordType.Sick,
    note: "tom-sick-note",
  });
  const tomVacation = await addLeave(team, tom.id, day(4), {
    note: "tom-vacation-note",
    approvedBy: ann.id,
  });
  const tomSickDay = await addLeave(team, tom.id, day(6), { type: CalendarRecordType.SickDay });
  const tomRejected = await addLeave(team, tom.id, day(9), {
    approved: false,
    rejected: true,
    rejectedBy: ann.id,
    rejectionReason: "tom-rejection-reason",
    note: "tom-rejected-note",
  });
  const tomCancelled = await addLeave(team, tom.id, day(11), { note: "tom-cancelled-note" });
  await cancelLeave(tomCancelled, ann.id);
  const tomPending = await addLeave(team, tom.id, day(13), {
    approved: false,
    note: "tom-pending-note",
  });
  const tomPendingSick = await addLeave(team, tom.id, day(16), {
    type: CalendarRecordType.Sick,
    approved: false,
    note: "tom-pending-sick-note",
  });
  const veraSick = await addLeave(team, vera.id, day(18), {
    type: CalendarRecordType.Sick,
    note: "vera-own-note",
  });
  const veraRejected = await addLeave(team, vera.id, day(20), {
    approved: false,
    rejected: true,
    rejectedBy: ann.id,
    rejectionReason: "vera-own-rejection",
  });
  const daveMirrored = await addLeave(source, dave.id, day(23), {
    type: CalendarRecordType.Sick,
    note: "dave-mirror-note",
  });

  return {
    mia,
    tom,
    vera,
    ann,
    tomSick,
    tomVacation,
    tomSickDay,
    tomRejected,
    tomCancelled,
    tomPending,
    tomPendingSick,
    veraSick,
    veraRejected,
    daveMirrored,
  };
};

describe("Sync pull carries only what a teammate may see", () => {
  let server: LoopbackServer;
  let s: Awaited<ReturnType<typeof seed>>;

  const pull = async (
    userId: string,
    options: { acceptsAway?: boolean; accepts?: string; cursor?: string } = {}
  ): Promise<{
    reset: boolean;
    hasMore: boolean;
    cursor: string;
    vacations: VacationRow[];
    userIds: string[];
    raw: string;
  }> => {
    let req = request(server.url)
      .get("/api/sync/pull")
      .set("Cookie", await authCookieFor(userId));
    if (options.acceptsAway) req = req.set(ACCEPTS_HEADER, "away");
    if (options.accepts !== undefined) req = req.set(ACCEPTS_HEADER, options.accepts);
    if (options.cursor !== undefined) req = req.query({ cursor: options.cursor });
    const res = await req.expect(200);
    return {
      reset: res.body.reset as boolean,
      hasMore: res.body.hasMore as boolean,
      cursor: res.body.cursor as string,
      vacations: res.body.vacations as VacationRow[],
      userIds: (res.body.users as { id: string }[]).map((row) => row.id),
      raw: JSON.stringify(res.body),
    };
  };

  const rowOf = (rows: VacationRow[], id: string) => rows.find((row) => row.id === id);

  /** A delta from ten minutes ago, everything else aged out of its window. */
  const deltaCursor = () => encodeSyncCursor(ago(10 * MINUTE));

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
    s = await seed();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  describe("a View member's snapshot", () => {
    it("leaves a teammate's note off their rows", async () => {
      const { vacations } = await pull(s.vera.id, { acceptsAway: true });

      const row = rowOf(vacations, s.tomVacation)!;
      expect(row.vacationType).toBe("VACATION");
      expect(row.note).toBeNull();
      expect(row.rejectionReason).toBeNull();
      expect(row.rejectedBy).toBeNull();
      expect(row.deletedByUserId).toBeNull();
    });

    it("sends a teammate's Sick as AWAY with no note to a pull that accepts it", async () => {
      const { vacations } = await pull(s.vera.id, { acceptsAway: true });

      const row = rowOf(vacations, s.tomSick)!;
      expect(row.vacationType).toBe("AWAY");
      expect(row.note).toBeNull();
    });

    it("leaves a teammate's Sick rows out of a pull that does not accept AWAY", async () => {
      const { vacations, raw } = await pull(s.vera.id);

      expect(rowOf(vacations, s.tomSick)).toBeUndefined();
      expect(rowOf(vacations, s.tomPendingSick)).toBeUndefined();
      expect(raw).not.toContain("tom-sick-note");
      expect(raw).not.toContain('"AWAY"');
    });

    it("leaves another person's rejected and cancelled rows out", async () => {
      for (const acceptsAway of [true, false]) {
        const { vacations, raw } = await pull(s.vera.id, { acceptsAway });

        expect(rowOf(vacations, s.tomRejected)).toBeUndefined();
        expect(rowOf(vacations, s.tomCancelled)).toBeUndefined();
        expect(raw).not.toContain("tom-rejection-reason");
        expect(raw).not.toMatch(/tom-[a-z-]*note/);
      }
    });
  });

  it("gives an approver of the target group the teammate view of a mirrored row", async () => {
    const { vacations } = await pull(s.ann.id, { acceptsAway: true });

    const row = rowOf(vacations, s.daveMirrored)!;
    expect(row.vacationType).toBe("AWAY");
    expect(row.note).toBeNull();
  });

  describe("a View member's delta", () => {
    it("sends a teammate's row rejected since the cursor as a content-nulled tombstone", async () => {
      await ageEverything();
      const rejectedAt = ago(1 * MINUTE);
      await db
        .update(vacation)
        .set({
          rejectedAt,
          rejectedBy: s.ann.id,
          rejectionReason: "tom-late-rejection",
          updatedAt: rejectedAt,
        })
        .where(eq(vacation.id, s.tomPending));

      const { reset, vacations, raw } = await pull(s.vera.id, {
        acceptsAway: true,
        cursor: deltaCursor(),
      });

      expect(reset).toBe(false);
      expect(rowOf(vacations, s.tomPending)).toMatchObject({
        userId: s.tom.id,
        vacationType: "VACATION",
        deletedAt: expect.any(String),
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
        note: null,
        approvedBy: null,
        deletedByUserId: null,
      });
      expect(raw).not.toContain("tom-late-rejection");
    });

    it("sends a teammate's row cancelled since the cursor as a content-nulled tombstone", async () => {
      await ageEverything();
      const cancelledAt = ago(1 * MINUTE);
      await cancelLeave(s.tomPending, s.ann.id, cancelledAt);

      const { vacations } = await pull(s.vera.id, { acceptsAway: true, cursor: deltaCursor() });

      expect(rowOf(vacations, s.tomPending)).toMatchObject({
        deletedAt: cancelledAt.toISOString(),
        note: null,
        deletedByUserId: null,
        rejectedBy: null,
      });
    });

    it("keeps the actor on a tombstone a privileged reader receives, so the phone keeps it", async () => {
      await ageEverything();
      const at = ago(1 * MINUTE);
      await db
        .update(vacation)
        .set({ rejectedAt: at, rejectedBy: s.ann.id, rejectionReason: "late", updatedAt: at })
        .where(eq(vacation.id, s.tomPending));
      await cancelLeave(s.tomPendingSick, s.ann.id, at);

      for (const acceptsAway of [true, false]) {
        const { vacations } = await pull(s.ann.id, { acceptsAway, cursor: deltaCursor() });

        expect(rowOf(vacations, s.tomPending)).toMatchObject({
          rejectedBy: s.ann.id,
          rejectionReason: "late",
          note: "tom-pending-note",
        });
        expect(rowOf(vacations, s.tomPendingSick)).toMatchObject({
          vacationType: "SICK",
          deletedByUserId: s.ann.id,
          note: "tom-pending-sick-note",
        });
      }
    });

    it("tombstones a cancelled teammate Sick as AWAY, and leaves it out without the header", async () => {
      await ageEverything();
      await cancelLeave(s.tomPendingSick, s.tom.id, ago(1 * MINUTE));

      const accepting = await pull(s.vera.id, { acceptsAway: true, cursor: deltaCursor() });
      expect(rowOf(accepting.vacations, s.tomPendingSick)).toMatchObject({
        vacationType: "AWAY",
        deletedAt: expect.any(String),
        note: null,
      });

      const older = await pull(s.vera.id, { cursor: deltaCursor() });
      expect(rowOf(older.vacations, s.tomPendingSick)).toBeUndefined();
    });
  });

  it("answers a cursor minted before teammates' rows were redacted with a snapshot", async () => {
    await ageEverything();
    const versionFour = Buffer.from(
      JSON.stringify({ v: 4, t: ago(10 * MINUTE).toISOString() }),
      "utf8"
    ).toString("base64url");

    const current = await pull(s.vera.id, { acceptsAway: true, cursor: deltaCursor() });
    expect(current.reset).toBe(false);

    const { reset } = await pull(s.vera.id, { acceptsAway: true, cursor: versionFour });
    expect(reset).toBe(true);
  });

  it("reads the header as a case-insensitive, comma-separated list", async () => {
    const { vacations } = await pull(s.vera.id, { accepts: "something-else, AWAY" });

    expect(rowOf(vacations, s.tomSick)!.vacationType).toBe("AWAY");
  });

  it("keeps every key the phone stores as NOT NULL on a tombstone, with a stored type", async () => {
    await ageEverything();
    const rejectedAt = ago(1 * MINUTE);
    await db
      .update(vacation)
      .set({ rejectedAt, rejectedBy: s.ann.id, rejectionReason: "late", updatedAt: rejectedAt })
      .where(eq(vacation.id, s.tomPending));
    const [stored] = await db.select().from(vacation).where(eq(vacation.id, s.tomPending));

    const { vacations } = await pull(s.vera.id, { cursor: deltaCursor() });

    expect(rowOf(vacations, s.tomPending)).toEqual({
      id: s.tomPending,
      userId: s.tom.id,
      groupId: stored!.groupId,
      organizationId: expect.any(String),
      requestId: stored!.requestId,
      requestedDay: day(13),
      startTime: null,
      endTime: null,
      vacationType: "VACATION",
      halfDay: false,
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      note: null,
      createdByUserId: null,
      deletedAt: rejectedAt.toISOString(),
      deletedByUserId: null,
      createdAt: stored!.createdAt.toISOString(),
      updatedAt: rejectedAt.toISOString(),
    });
  });

  it("names nobody who rejected or cancelled a teammate's row", async () => {
    const olga = await makeUser("Olga Orgadmin");
    const organizationId = (await ensureOrganizationForUser(s.mia.id)).id;
    await db.insert(organizationUsers).values({
      id: uuidv4(),
      organizationId,
      userId: olga.id,
      grantedByUserId: s.mia.id,
    });
    await ageEverything();
    const at = ago(1 * MINUTE);
    await db
      .update(vacation)
      .set({ rejectedAt: at, rejectedBy: olga.id, rejectionReason: "no", updatedAt: at })
      .where(eq(vacation.id, s.tomPending));
    await cancelLeave(s.tomPendingSick, olga.id, at);

    const snapshot = await pull(s.vera.id, { acceptsAway: true });
    const delta = await pull(s.vera.id, { acceptsAway: true, cursor: deltaCursor() });

    expect(rowOf(delta.vacations, s.tomPending)!.deletedAt).not.toBeNull();
    expect(snapshot.userIds).not.toContain(olga.id);
    expect(delta.userIds).not.toContain(olga.id);
  });

  it("answers a change to the caller's organization admin row with a snapshot", async () => {
    const organizationId = (await ensureOrganizationForUser(s.mia.id)).id;
    const grantId = uuidv4();
    await db.insert(organizationUsers).values({
      id: grantId,
      organizationId,
      userId: s.vera.id,
      grantedByUserId: s.mia.id,
    });
    const asAdmin = await pull(s.vera.id, { acceptsAway: true });
    expect(rowOf(asAdmin.vacations, s.tomSick)!.note).toBe("tom-sick-note");

    await ageEverything();
    const longAgo = ago(365 * 24 * 60 * MINUTE);
    await db
      .update(organizationUsers)
      .set({ updatedAt: longAgo, createdAt: longAgo })
      .where(eq(organizationUsers.id, grantId));
    expect((await pull(s.vera.id, { acceptsAway: true, cursor: deltaCursor() })).reset).toBe(false);

    const revokedAt = ago(1 * MINUTE);
    await db
      .update(organizationUsers)
      .set({ deletedAt: revokedAt, updatedAt: revokedAt })
      .where(eq(organizationUsers.id, grantId));

    const revoked = await pull(s.vera.id, { acceptsAway: true, cursor: deltaCursor() });
    expect(revoked.reset).toBe(true);
    expect(rowOf(revoked.vacations, s.tomSick)!.note).toBeNull();
  });

  it("answers a change to who approves a mirrored source group with a snapshot", async () => {
    const [mirrored] = await db.select().from(vacation).where(eq(vacation.id, s.daveMirrored));
    const sourceGroupId = mirrored!.groupId;
    await db
      .update(groups)
      .set({ mainApprovalUser: s.vera.id })
      .where(eq(groups.id, sourceGroupId));
    const asApprover = await pull(s.vera.id, { acceptsAway: true });
    expect(rowOf(asApprover.vacations, s.daveMirrored)!.note).toBe("dave-mirror-note");

    await ageEverything();
    expect((await pull(s.vera.id, { acceptsAway: true, cursor: deltaCursor() })).reset).toBe(false);
    const changedAt = ago(1 * MINUTE);
    await db
      .update(groups)
      .set({ mainApprovalUser: null, updatedAt: changedAt })
      .where(eq(groups.id, sourceGroupId));

    const after = await pull(s.vera.id, { acceptsAway: true, cursor: deltaCursor() });
    expect(after.reset).toBe(true);
    expect(rowOf(after.vacations, s.daveMirrored)).toMatchObject({
      vacationType: "AWAY",
      note: null,
    });
  });

  it("delivers every visible row across pages when hidden rows sit between them", async () => {
    const firstDay = Date.UTC(YEAR, 0, 1);
    const dayAt = (offset: number) =>
      new Date(firstDay + offset * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    const stamp = new Date();
    const base = { userId: s.tom.id, halfDay: false, createdAt: stamp, updatedAt: stamp };
    const [teamGroup] = await db.select().from(vacation).where(eq(vacation.id, s.tomVacation));
    const groupId = teamGroup!.groupId;

    const [daveRow] = await db.select().from(vacation).where(eq(vacation.id, s.daveMirrored));
    const dave = daveRow!.userId;
    const visible: string[] = [];
    const rows: (typeof vacation.$inferInsert)[] = [];
    for (let offset = 0; offset < SYNC_PAGE_SIZE + 50; offset++) {
      const id = uuidv4();
      visible.push(id);
      rows.push({
        ...base,
        id,
        groupId,
        requestId: uuidv4(),
        requestedDay: dayAt(400 + offset),
        vacationType: CalendarRecordType.Vacation,
        approvedAt: stamp,
      });
      rows.push({
        ...base,
        id: uuidv4(),
        groupId,
        requestId: uuidv4(),
        requestedDay: dayAt(400 + offset),
        vacationType: offset % 2 === 0 ? CalendarRecordType.Sick : CalendarRecordType.HomeOffice,
        rejectedAt: stamp,
        rejectionReason: "hidden",
      });
      rows.push({
        ...base,
        id: uuidv4(),
        userId: dave,
        groupId,
        requestId: uuidv4(),
        requestedDay: dayAt(400 + offset),
        vacationType: CalendarRecordType.Sick,
        approvedAt: stamp,
        note: "hidden",
      });
    }
    for (let start = 0; start < rows.length; start += 500) {
      await db.insert(vacation).values(rows.slice(start, start + 500));
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await pull(s.vera.id, { cursor });
      for (const row of page.vacations) seen.add(row.id);
      expect(page.raw).not.toContain("hidden");
      pages++;
      if (!page.hasMore) break;
      cursor = page.cursor;
    }

    expect(pages).toBeGreaterThan(1);
    expect(visible.filter((id) => !seen.has(id))).toEqual([]);
  });

  // Still allowed, before and after the fix.

  it("sends the caller's own Sick, notes and rejected rows in full", async () => {
    for (const acceptsAway of [true, false]) {
      const { vacations } = await pull(s.vera.id, { acceptsAway });

      expect(rowOf(vacations, s.veraSick)).toMatchObject({
        vacationType: "SICK",
        note: "vera-own-note",
      });
      expect(rowOf(vacations, s.veraRejected)).toMatchObject({
        rejectionReason: "vera-own-rejection",
        rejectedBy: s.ann.id,
      });
    }
  });

  it("leaves an approver's pull of their own group unchanged", async () => {
    for (const acceptsAway of [true, false]) {
      const { vacations } = await pull(s.ann.id, { acceptsAway });

      expect(rowOf(vacations, s.tomSick)).toMatchObject({
        vacationType: "SICK",
        note: "tom-sick-note",
      });
      expect(rowOf(vacations, s.tomRejected)).toMatchObject({
        rejectionReason: "tom-rejection-reason",
        rejectedBy: s.ann.id,
        note: "tom-rejected-note",
      });
      expect(rowOf(vacations, s.tomCancelled)).toMatchObject({
        deletedByUserId: s.ann.id,
        note: "tom-cancelled-note",
      });
    }
  });

  it("keeps a teammate's Sick day as SICK_DAY", async () => {
    for (const acceptsAway of [true, false]) {
      const { vacations } = await pull(s.vera.id, { acceptsAway });

      expect(rowOf(vacations, s.tomSickDay)!.vacationType).toBe("SICK_DAY");
    }
  });
});
