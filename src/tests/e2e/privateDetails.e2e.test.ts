import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { createVacationEvent } from "../../services/vacationEvent/vacationEventServices.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addMirror,
  cancelLeave,
  dayIn,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

const YEAR = new Date().getFullYear() + 1;
const MONTH = 3;
const day = (d: number) => dayIn(YEAR, MONTH, d);

/**
 * "Team" belongs to the owner's organization and is managed by Mia, who holds
 * no membership row. Ann approves it. Bob, Alice and Carol are View members.
 * Dave belongs to Team and mirrors his own group "Source" into it; Ann has no
 * standing in Source.
 */
const seed = async () => {
  const owner = await makeUser("Olivia Owner");
  const mia = await makeUser("Mia Manager");
  const ann = await makeUser("Ann Approver");
  const bob = await makeUser("Bob Member");
  const alice = await makeUser("Alice Member");
  const carol = await makeUser("Carol Member");
  const dave = await makeUser("Dave Mirror");

  const team = await makeGroup("Team", mia.id, { organizationOwnerId: owner.id });
  await addMember(team, ann.id, { viewAccess: true, approverAccess: true });
  for (const member of [bob, alice, carol]) await addMember(team, member.id, { viewAccess: true });
  await addMember(team, dave.id);

  const source = await makeGroup("Source", dave.id);
  await addMember(source, dave.id, { viewAccess: true, adminAccess: true });
  await addMirror(dave.id, source, team);

  const bobSick = await addLeave(team, bob.id, day(2), {
    type: CalendarRecordType.Sick,
    approved: false,
    note: "bob-sick-note",
  });
  const bobSickDay = await addLeave(team, bob.id, day(4), {
    type: CalendarRecordType.SickDay,
    note: "bob-sickday-note",
  });
  const alicePending = await addLeave(team, alice.id, day(9), {
    approved: false,
    note: "alice-private-note",
  });
  await createVacationEvent({
    id: uuidv4(),
    vacationId: alicePending,
    eventType: vacationEventType.Comment,
    actorUserId: ann.id,
    reason: "alice-private-comment",
  });
  const aliceRejected = await addLeave(team, alice.id, day(11), {
    approved: false,
    rejected: true,
    rejectedBy: ann.id,
    rejectionReason: "alice-rejection-reason",
  });
  const aliceCancelled = await addLeave(team, alice.id, day(13), { note: "alice-cancel-note" });
  await cancelLeave(aliceCancelled, alice.id);
  const carolSick = await addLeave(team, carol.id, day(16), {
    type: CalendarRecordType.Sick,
    note: "carol-own-note",
  });
  const carolRejected = await addLeave(team, carol.id, day(18), {
    approved: false,
    rejected: true,
    rejectedBy: ann.id,
    rejectionReason: "carol-own-rejection",
  });
  const daveSick = await addLeave(source, dave.id, day(20), {
    type: CalendarRecordType.Sick,
    note: "dave-sick-note",
  });

  return {
    owner,
    mia,
    ann,
    bob,
    alice,
    carol,
    team,
    bobSick,
    bobSickDay,
    alicePending,
    aliceRejected,
    aliceCancelled,
    carolSick,
    carolRejected,
    daveSick,
  };
};

type Seeded = Awaited<ReturnType<typeof seed>>;
type Row = {
  id: string;
  userId: string;
  vacationType: string;
  note?: string | null;
  rejectionReason?: string | null;
  rejectedAt?: string | null;
  deletedAt?: string | null;
};

const PRIVATE_STRINGS = [
  "bob-sick-note",
  "bob-sickday-note",
  "alice-private-note",
  "alice-private-comment",
  "alice-rejection-reason",
  "alice-cancel-note",
  "dave-sick-note",
];

describe("Teammates see Sick as Away and never read private details", () => {
  let server: LoopbackServer;
  let s: Seeded;

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

  const get = async (userId: string, path: string, query: Record<string, unknown> = {}) =>
    request(server.url)
      .get(path)
      .query(query)
      .set("Cookie", await authCookieFor(userId));

  const detail = (userId: string, vacationId: string) => get(userId, `/api/vacation/${vacationId}`);

  const list = async (userId: string, groupId: string) => {
    const res = await get(userId, "/api/vacation", {
      year: YEAR,
      month: MONTH,
      groupId,
      includeCancelled: true,
    });
    expect(res.status).toBe(200);
    return res.body as Row[];
  };

  const calendar = async (userId: string, groupId: string) => {
    const res = await get(userId, "/api/vacation/calendar", { year: YEAR, month: MONTH, groupId });
    expect(res.status).toBe(200);
    return res.body as Row[];
  };

  const comment = async (userId: string, vacationId: string) =>
    request(server.url)
      .post(`/api/vacation/comment/${vacationId}`)
      .set("Cookie", await authCookieFor(userId))
      .send({ message: "a comment" });

  const rowById = (rows: Row[], id: string) => rows.find((row) => row.id === id);

  describe("a View member (teammate)", () => {
    it("reads a teammate's Sick row by id as Away", async () => {
      const res = await detail(s.carol.id, s.bobSick);

      expect(res.status).toBe(200);
      expect(res.body.vacationType).toBe("AWAY");
      expect(res.body.note ?? null).toBeNull();
    });

    it("gets no note, rejection reason or history on a teammate's request", async () => {
      const res = await detail(s.carol.id, s.alicePending);

      expect(res.status).toBe(200);
      expect(res.body.note ?? null).toBeNull();
      expect(res.body.rejectionReason ?? null).toBeNull();
      expect(res.body.history ?? []).toEqual([]);
      expect(res.body.canReadPrivateDetails).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain("alice-private-comment");
    });

    it("cannot open a teammate's rejected or cancelled row by id", async () => {
      for (const id of [s.aliceRejected, s.aliceCancelled]) {
        const res = await detail(s.carol.id, id);
        expect(res.status).toBe(403);
      }
    });

    it("sees a teammate's Sick as Away in the list and the calendar", async () => {
      for (const rows of [await list(s.carol.id, s.team), await calendar(s.carol.id, s.team)]) {
        expect(rowById(rows, s.bobSick)?.vacationType).toBe("AWAY");
      }
    });

    it("gets no teammate's rejected or cancelled rows, and no private strings, in the list and the calendar", async () => {
      for (const rows of [await list(s.carol.id, s.team), await calendar(s.carol.id, s.team)]) {
        expect(rowById(rows, s.aliceRejected)).toBeUndefined();
        expect(rowById(rows, s.aliceCancelled)).toBeUndefined();
        const others = rows.filter((row) => row.userId !== s.carol.id);
        for (const row of others) {
          expect(row.note ?? null).toBeNull();
          expect(row.rejectionReason ?? null).toBeNull();
        }
        const wire = JSON.stringify(rows);
        for (const secret of PRIVATE_STRINGS) expect(wire).not.toContain(secret);
      }
    });

    it("cannot comment on a teammate's request", async () => {
      const res = await comment(s.carol.id, s.alicePending);

      expect(res.status).toBe(403);
    });

    it("still sees a teammate's Sick day as itself", async () => {
      const res = await detail(s.carol.id, s.bobSickDay);
      expect(res.status).toBe(200);
      expect(res.body.vacationType).toBe(CalendarRecordType.SickDay);

      const rows = await list(s.carol.id, s.team);
      expect(rowById(rows, s.bobSickDay)?.vacationType).toBe(CalendarRecordType.SickDay);
    });

    it("still reads their own Sick and rejected rows in full", async () => {
      const rows = await list(s.carol.id, s.team);
      expect(rowById(rows, s.carolSick)).toMatchObject({
        vacationType: CalendarRecordType.Sick,
        note: "carol-own-note",
      });
      expect(rowById(rows, s.carolRejected)).toMatchObject({
        rejectionReason: "carol-own-rejection",
      });
    });
  });

  describe("an approver of a group the row is only mirrored into", () => {
    it("gets the teammate view of the mirrored Sick row", async () => {
      for (const rows of [await list(s.ann.id, s.team), await calendar(s.ann.id, s.team)]) {
        const mirrored = rowById(rows, s.daveSick);

        expect(mirrored).toBeDefined();
        expect(mirrored?.vacationType).toBe("AWAY");
        expect(mirrored?.note ?? null).toBeNull();
      }
    });
  });

  describe("privileged readers of the row's own group keep the full row", () => {
    const privileged: [string, (seeded: Seeded) => { id: string }][] = [
      ["the approver", (seeded) => seeded.ann],
      ["the manager without a membership row", (seeded) => seeded.mia],
      ["an org admin who isn't a member", (seeded) => seeded.owner],
    ];

    it("the owner reads their own Sick row, note and history", async () => {
      const res = await detail(s.bob.id, s.bobSick);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        vacationType: CalendarRecordType.Sick,
        note: "bob-sick-note",
        canReadPrivateDetails: true,
      });
      expect(Array.isArray(res.body.history)).toBe(true);
    });

    it.each(privileged)("%s reads Sick, the note and the history by id", async (_, pick) => {
      const reader = pick(s).id;

      const sick = await detail(reader, s.bobSick);
      expect(sick.status).toBe(200);
      expect(sick.body.vacationType).toBe(CalendarRecordType.Sick);

      const pending = await detail(reader, s.alicePending);
      expect(pending.status).toBe(200);
      expect(pending.body.note).toBe("alice-private-note");
      expect(pending.body.canReadPrivateDetails).toBe(true);
      expect(JSON.stringify(pending.body.history)).toContain("alice-private-comment");

      const rejected = await detail(reader, s.aliceRejected);
      expect(rejected.status).toBe(200);
      expect(rejected.body.rejectionReason).toBe("alice-rejection-reason");
    });

    it.each(privileged)("%s sees rejected and cancelled rows in the list", async (_, pick) => {
      const rows = await list(pick(s).id, s.team);

      expect(rowById(rows, s.bobSick)).toMatchObject({
        vacationType: CalendarRecordType.Sick,
        note: "bob-sick-note",
      });
      expect(rowById(rows, s.aliceRejected)).toMatchObject({
        rejectionReason: "alice-rejection-reason",
      });
      expect(rowById(rows, s.aliceCancelled)).toBeDefined();
    });

    it("the approver may comment", async () => {
      const res = await comment(s.ann.id, s.alicePending);

      expect(res.status).toBe(200);
    });
  });
});
