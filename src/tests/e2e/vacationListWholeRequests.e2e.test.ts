import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addMirror,
  cancelLeave,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

/**
 * Bob's pending Request runs Thu 28 Oct – Tue 2 Nov 2027 across a weekend and
 * a month edge, plus a cancelled Wed 3 Nov. Alice's Sick Request has two
 * approved days either side of the edge and a rejected 2 Nov. Dave's Request
 * lives in "Source" and is mirrored into "Team". Bob's 10 Nov day is a Request
 * of its own that never touches October. Alice's Home office Request has its
 * only October day rejected and a pending 4 Nov.
 */
const seed = async () => {
  const owner = await makeUser("Olivia Owner");
  const mia = await makeUser("Mia Manager");
  const ann = await makeUser("Ann Approver");
  const bob = await makeUser("Bob Member");
  const alice = await makeUser("Alice Member");
  const carol = await makeUser("Carol Viewer");
  const dave = await makeUser("Dave Mirror");

  const team = await makeGroup("Team", mia.id, { organizationOwnerId: owner.id });
  await addMember(team, ann.id, { viewAccess: true, approverAccess: true });
  for (const member of [bob, alice, carol]) await addMember(team, member.id, { viewAccess: true });
  await addMember(team, dave.id);

  const source = await makeGroup("Source", dave.id);
  await addMember(source, dave.id, { viewAccess: true, adminAccess: true });
  await addMirror(dave.id, source, team);

  const bobRequest = uuidv4();
  const bobPending: Record<string, string> = {};
  for (const day of ["2027-10-28", "2027-10-29", "2027-11-01", "2027-11-02"]) {
    bobPending[day] = await addLeave(team, bob.id, day, {
      approved: false,
      requestId: bobRequest,
      note: "bob-request-note",
    });
  }
  const bobCancelled = await addLeave(team, bob.id, "2027-11-03", {
    approved: false,
    requestId: bobRequest,
    note: "bob-request-note",
  });
  await cancelLeave(bobCancelled, bob.id);
  const bobLater = await addLeave(team, bob.id, "2027-11-10", { approved: false });

  const aliceRequest = uuidv4();
  const aliceSick = [
    await addLeave(team, alice.id, "2027-10-29", {
      type: CalendarRecordType.Sick,
      requestId: aliceRequest,
      note: "alice-sick-note",
    }),
    await addLeave(team, alice.id, "2027-11-01", {
      type: CalendarRecordType.Sick,
      requestId: aliceRequest,
      note: "alice-sick-note",
    }),
  ];
  const aliceRejected = await addLeave(team, alice.id, "2027-11-02", {
    type: CalendarRecordType.Sick,
    approved: false,
    rejected: true,
    rejectedBy: ann.id,
    rejectionReason: "alice-rejection-reason",
    requestId: aliceRequest,
  });

  const aliceHomeRequest = uuidv4();
  const aliceHome = [
    await addLeave(team, alice.id, "2027-10-27", {
      type: CalendarRecordType.HomeOffice,
      approved: false,
      rejected: true,
      rejectedBy: ann.id,
      requestId: aliceHomeRequest,
    }),
    await addLeave(team, alice.id, "2027-11-04", {
      type: CalendarRecordType.HomeOffice,
      approved: false,
      requestId: aliceHomeRequest,
    }),
  ];

  const daveRequest = uuidv4();
  const daveMirrored = [
    await addLeave(source, dave.id, "2027-10-29", { requestId: daveRequest, note: "dave-note" }),
    await addLeave(source, dave.id, "2027-11-01", { requestId: daveRequest, note: "dave-note" }),
  ];

  return {
    ann,
    bob,
    carol,
    dave,
    team,
    source,
    bobPending,
    bobCancelled,
    bobLater,
    aliceSick,
    aliceRejected,
    aliceHome,
    daveMirrored,
  };
};

type Seeded = Awaited<ReturnType<typeof seed>>;
type Row = {
  id: string;
  requestedDay: string;
  vacationType: string;
  note: string | null;
  rejectionReason: string | null;
  deletedAt: string | null;
  mirroredFromGroupId: string | null;
  canApprove: boolean;
};

describe("GET /api/vacation?wholeRequests=true lists every row of each Request in the month", () => {
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

  const list = async (userId: string, query: Record<string, unknown>) =>
    request(server.url)
      .get("/api/vacation")
      .query({ year: 2027, includeCancelled: true, ...query })
      .set("Cookie", await authCookieFor(userId));

  const listOk = async (userId: string, query: Record<string, unknown>) => {
    const res = await list(userId, query);
    expect(res.status).toBe(200);
    return res.body as Row[];
  };

  const ids = (rows: Row[]) => rows.map((row) => row.id).sort();
  const sorted = (values: string[]) => [...values].sort();
  const bobRequestRowIds = () => [...Object.values(s.bobPending), s.bobCancelled];

  it("without the flag keeps the list inside the month", async () => {
    const rows = await listOk(s.ann.id, { month: 10, groupId: s.team });

    expect(rows.every((row) => row.requestedDay.startsWith("2027-10"))).toBe(true);
    expect(ids(rows)).toEqual(
      sorted([
        s.bobPending["2027-10-28"]!,
        s.bobPending["2027-10-29"]!,
        s.aliceSick[0]!,
        s.aliceHome[0]!,
        s.daveMirrored[0]!,
      ])
    );
  });

  it("in own scope returns the Request's rows in other months, and no Request outside it", async () => {
    const rows = await listOk(s.bob.id, { month: 10, wholeRequests: true });

    expect(ids(rows)).toEqual(sorted(bobRequestRowIds()));
    expect(rows.map((row) => row.id)).not.toContain(s.bobLater);
  });

  it("in own scope without the flag keeps the list inside the month", async () => {
    const rows = await listOk(s.bob.id, { month: 10 });

    expect(ids(rows)).toEqual(sorted([s.bobPending["2027-10-28"]!, s.bobPending["2027-10-29"]!]));
  });

  it("leaves out cancelled rows of the Request unless includeCancelled is set", async () => {
    const rows = await listOk(s.bob.id, {
      month: 10,
      wholeRequests: true,
      includeCancelled: false,
    });

    expect(ids(rows)).toEqual(sorted(Object.values(s.bobPending)));
  });

  it("in group scope gives an approver every row, with canApprove on the pending ones", async () => {
    const rows = await listOk(s.ann.id, { month: 10, groupId: s.team, wholeRequests: true });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(ids(rows)).toEqual(
      sorted([
        ...bobRequestRowIds(),
        ...s.aliceSick,
        s.aliceRejected,
        ...s.aliceHome,
        ...s.daveMirrored,
      ])
    );
    for (const id of Object.values(s.bobPending)) {
      expect(byId.get(id)?.canApprove).toBe(true);
      expect(byId.get(id)?.note).toBe("bob-request-note");
    }
    expect(byId.get(s.bobCancelled)?.canApprove).toBe(false);
    expect(byId.get(s.aliceSick[1]!)?.vacationType).toBe("SICK");
    expect(byId.get(s.aliceRejected)?.rejectionReason).toBe("alice-rejection-reason");
  });

  it("gives a mirrored Request's extra rows the mirror fields and the teammate view", async () => {
    const rows = await listOk(s.ann.id, { month: 10, groupId: s.team, wholeRequests: true });
    const mirrored = rows.filter((row) => s.daveMirrored.includes(row.id));

    expect(mirrored).toHaveLength(2);
    for (const row of mirrored) {
      expect(row.mirroredFromGroupId).toBe(s.source);
      expect(row.note).toBeNull();
      expect(row.canApprove).toBe(false);
    }
  });

  it("gives a teammate the redacted shape on the extra rows too", async () => {
    const res = await list(s.carol.id, { month: 10, groupId: s.team, wholeRequests: true });
    expect(res.status).toBe(200);
    const rows = res.body as Row[];
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(ids(rows)).toEqual(
      sorted([...Object.values(s.bobPending), ...s.aliceSick, ...s.daveMirrored])
    );
    expect(byId.get(s.aliceSick[1]!)?.vacationType).toBe("AWAY");
    expect(byId.get(s.bobPending["2027-11-02"]!)?.note).toBeNull();
    expect(rows.every((row) => !row.canApprove)).toBe(true);
    const body = JSON.stringify(res.body);
    for (const secret of ["bob-request-note", "alice-sick-note", "alice-rejection-reason"]) {
      expect(body).not.toContain(secret);
    }
  });

  it("leaves out a Request whose only rows in the month the teammate may not see", async () => {
    const rows = await listOk(s.carol.id, { month: 10, groupId: s.team, wholeRequests: true });

    expect(rows.map((row) => row.id)).not.toContain(s.aliceHome[1]);
  });

  it("returns the same Request from the other month it touches", async () => {
    const rows = await listOk(s.ann.id, { month: 11, groupId: s.team, wholeRequests: true });

    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([s.bobPending["2027-10-28"], s.bobPending["2027-10-29"], s.bobLater])
    );
  });

  it("still refuses a member who cannot see the whole group", async () => {
    const res = await list(s.dave.id, { month: 10, groupId: s.team, wholeRequests: true });

    expect(res.status).toBe(403);
  });
});
