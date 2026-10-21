import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { v4 as uuidv4 } from "uuid";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  cancelLeave,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

/**
 * Bob has an approved day on each side of the Nov 2026 – Jan 2027 range and
 * three inside it, across the year boundary. 1 Feb 2027 is the range's `to`,
 * so it stays out. The outside days each share a Request with a day inside:
 * 30 Oct with 2 Nov, and 1 Feb with 29 Jan. 31 Dec is Sick, with a note only
 * the approver may read. Carol sees the group as a teammate; Dave is a member
 * without view access. Dave's Request has its only in-range day cancelled and
 * a pending 3 Feb.
 */
const seed = async () => {
  const mia = await makeUser("Mia Manager");
  const ann = await makeUser("Ann Approver");
  const bob = await makeUser("Bob Member");
  const carol = await makeUser("Carol Viewer");
  const dave = await makeUser("Dave Member");

  const team = await makeGroup("Team", mia.id);
  await addMember(team, ann.id, { viewAccess: true, approverAccess: true });
  await addMember(team, bob.id, { viewAccess: true });
  await addMember(team, carol.id, { viewAccess: true });
  await addMember(team, dave.id);

  const autumn = uuidv4();
  const winter = uuidv4();
  const days = {
    "2026-10-30": await addLeave(team, bob.id, "2026-10-30", { requestId: autumn }),
    "2026-11-02": await addLeave(team, bob.id, "2026-11-02", { requestId: autumn }),
    "2026-12-31": await addLeave(team, bob.id, "2026-12-31", {
      type: CalendarRecordType.Sick,
      note: "bob-sick-note",
    }),
    "2027-01-29": await addLeave(team, bob.id, "2027-01-29", { requestId: winter }),
    "2027-02-01": await addLeave(team, bob.id, "2027-02-01", { requestId: winter }),
  };

  const daveRequest = uuidv4();
  const daveCancelled = await addLeave(team, dave.id, "2027-01-15", {
    approved: false,
    requestId: daveRequest,
  });
  await cancelLeave(daveCancelled, dave.id);
  const daveLater = await addLeave(team, dave.id, "2027-02-03", {
    approved: false,
    requestId: daveRequest,
  });

  return { ann, bob, carol, dave, team, days, daveCancelled, daveLater };
};

type Seeded = Awaited<ReturnType<typeof seed>>;
type Row = { id: string; requestedDay: string; vacationType: string; note: string | null };

describe("GET /api/vacation over a from/to range", () => {
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
      .query(query)
      .set("Cookie", await authCookieFor(userId));

  const days = (rows: Row[]) => rows.map((row) => row.requestedDay).sort();

  it("returns the caller's rows from the first month to the one before `to`, across the year", async () => {
    const res = await list(s.bob.id, { from: "2026-11-01", to: "2027-02-01" });

    expect(res.status).toBe(200);
    expect(days(res.body as Row[])).toEqual(["2026-11-02", "2026-12-31", "2027-01-29"]);
  });

  it("with wholeRequests returns every day of a Request that has one in the range", async () => {
    const res = await list(s.bob.id, { from: "2026-11-01", to: "2027-02-01", wholeRequests: true });

    expect(res.status).toBe(200);
    expect(days(res.body as Row[])).toEqual(Object.keys(s.days).sort());
  });

  it("in group scope gives an approver the range in full", async () => {
    const res = await list(s.ann.id, { from: "2026-11-01", to: "2027-02-01", groupId: s.team });

    expect(res.status).toBe(200);
    const rows = res.body as Row[];
    expect(days(rows)).toEqual(["2026-11-02", "2026-12-31", "2027-01-29"]);
    const sick = rows.find((row) => row.requestedDay === "2026-12-31");
    expect(sick?.vacationType).toBe("SICK");
    expect(sick?.note).toBe("bob-sick-note");
  });

  it("in group scope gives a teammate the redacted view over the range", async () => {
    const res = await list(s.carol.id, { from: "2026-11-01", to: "2027-02-01", groupId: s.team });

    expect(res.status).toBe(200);
    const rows = res.body as Row[];
    expect(days(rows)).toEqual(["2026-11-02", "2026-12-31", "2027-01-29"]);
    const sick = rows.find((row) => row.requestedDay === "2026-12-31");
    expect(sick?.vacationType).toBe("AWAY");
    expect(sick?.note).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("bob-sick-note");
  });

  it("in group scope keeps a Request only when the caller sees one of its rows in range", async () => {
    const query = {
      from: "2026-11-01",
      to: "2027-02-01",
      groupId: s.team,
      wholeRequests: true,
      includeCancelled: true,
    };
    const approver = await list(s.ann.id, query);
    const teammate = await list(s.carol.id, query);

    expect(approver.status).toBe(200);
    expect(teammate.status).toBe(200);
    const bobDays = Object.keys(s.days);
    expect(days(approver.body as Row[])).toEqual([...bobDays, "2027-01-15", "2027-02-03"].sort());
    expect(days(teammate.body as Row[])).toEqual(bobDays.sort());
  });

  it("in group scope refuses a member who cannot see the whole group", async () => {
    const res = await list(s.dave.id, { from: "2026-11-01", to: "2027-02-01", groupId: s.team });

    expect(res.status).toBe(403);
  });

  it("with year and month alone still lists that one month", async () => {
    const res = await list(s.bob.id, { year: 2026, month: 12 });

    expect(res.status).toBe(200);
    expect(days(res.body as Row[])).toEqual(["2026-12-31"]);
  });

  it.each([
    ["only `from`", { from: "2026-11-01" }],
    ["only `to`", { to: "2027-02-01" }],
    ["a range with `year`", { from: "2026-11-01", to: "2027-02-01", year: 2026 }],
    ["a range with `month`", { from: "2026-11-01", to: "2027-02-01", month: 11 }],
    ["a `from` not in YYYY-MM-DD", { from: "2026-11", to: "2027-02-01" }],
    ["a `to` that is no calendar day", { from: "2026-11-01", to: "2027-02-30" }],
    ["a repeated `from`", { from: ["2026-11-01", "2026-12-01"], to: "2027-02-01" }],
    ["`from` equal to `to`", { from: "2026-11-01", to: "2026-11-01" }],
    ["`from` after `to`", { from: "2027-02-01", to: "2026-11-01" }],
    ["a span over 36 months", { from: "2026-11-01", to: "2029-11-02" }],
    ["36 months and a day from a leap day", { from: "2028-02-29", to: "2031-03-01" }],
  ])("refuses %s with a 400", async (_, query) => {
    const res = await list(s.bob.id, query);

    expect(res.status).toBe(400);
  });

  it("accepts a span of exactly 36 months", async () => {
    const res = await list(s.bob.id, { from: "2026-11-01", to: "2029-11-01" });

    expect(res.status).toBe(200);
  });
});
